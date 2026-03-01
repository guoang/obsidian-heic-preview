const { Plugin, FileView } = require('obsidian');
const { execFile } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/obsidian-heic-preview';
const MAX_CONCURRENT = 3;
const VIEW_TYPE_HEIC = 'heic-preview';

// ---------------------------------------------------------------------------
// HeicConverter — sips invocation + 3-tier cache + concurrency control
// ---------------------------------------------------------------------------
class HeicConverter {
  constructor() {
    this.memCache = new Map();   // key: "absPath:mtime" → blobURL
    this.inflight = new Map();   // key: "absPath:mtime" → Promise<blobURL>
    this.running = 0;
    this.queue = [];
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  async convert(absPath, mtime) {
    const cacheKey = absPath + ':' + mtime;

    // [1] Memory cache
    if (this.memCache.has(cacheKey)) {
      return this.memCache.get(cacheKey);
    }

    // Deduplicate inflight requests
    if (this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey);
    }

    const promise = this._doConvert(absPath, mtime, cacheKey);
    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  async _doConvert(absPath, mtime, cacheKey) {
    const hash = createHash('md5').update(absPath).digest('hex');
    const diskPath = path.join(CACHE_DIR, hash + '.jpg');

    // [2] Disk cache — check mtime marker file
    const markerPath = diskPath + '.meta';
    try {
      const marker = fs.readFileSync(markerPath, 'utf8');
      if (marker === cacheKey && fs.existsSync(diskPath)) {
        const buf = fs.readFileSync(diskPath);
        const blob = new Blob([buf], { type: 'image/jpeg' });
        const blobURL = URL.createObjectURL(blob);
        this.memCache.set(cacheKey, blobURL);
        return blobURL;
      }
    } catch {
      // No disk cache, proceed to sips
    }

    // [3] sips conversion with concurrency limit
    await this._acquireSlot();
    try {
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/sips', [
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', '85',
          '--resampleHeightWidthMax', '2048',
          absPath,
          '-o', diskPath,
        ], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Write mtime marker
      fs.writeFileSync(markerPath, cacheKey);

      const buf = fs.readFileSync(diskPath);
      const blob = new Blob([buf], { type: 'image/jpeg' });
      const blobURL = URL.createObjectURL(blob);
      this.memCache.set(cacheKey, blobURL);
      return blobURL;
    } finally {
      this._releaseSlot();
    }
  }

  _acquireSlot() {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  _releaseSlot() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.running--;
    }
  }

  destroy() {
    for (const blobURL of this.memCache.values()) {
      URL.revokeObjectURL(blobURL);
    }
    this.memCache.clear();
    this.inflight.clear();
    this.queue = [];
    this.running = 0;
  }
}

// ---------------------------------------------------------------------------
// HeicFileView — open .heic files directly in a tab
// ---------------------------------------------------------------------------
class HeicFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.imgEl = null;
  }

  getViewType() {
    return VIEW_TYPE_HEIC;
  }

  getDisplayText() {
    return this.file ? this.file.name : 'HEIC Preview';
  }

  getIcon() {
    return 'image';
  }

  async onLoadFile(file) {
    const container = this.contentEl;
    container.empty();
    container.addClass('heic-preview-view');

    const wrapper = container.createDiv({ cls: 'heic-preview-wrapper' });
    const loading = wrapper.createDiv({ cls: 'heic-preview-loading', text: 'Converting HEIC…' });

    try {
      const basePath = this.app.vault.adapter.getBasePath();
      const absPath = path.join(basePath, file.path);
      const stat = fs.statSync(absPath);
      const mtime = stat.mtimeMs.toString();
      const blobURL = await this.plugin.converter.convert(absPath, mtime);

      loading.remove();
      this.imgEl = wrapper.createEl('img', { cls: 'heic-preview-img' });
      this.imgEl.src = blobURL;
    } catch (e) {
      loading.remove();
      wrapper.createDiv({ cls: 'heic-preview-error', text: 'Failed to convert HEIC: ' + e.message });
    }
  }

  async onUnloadFile(file) {
    this.contentEl.empty();
    this.imgEl = null;
  }

  canAcceptExtension(extension) {
    return extension === 'heic';
  }
}

// ---------------------------------------------------------------------------
// HeicPreviewPlugin
// ---------------------------------------------------------------------------
class HeicPreviewPlugin extends Plugin {
  async onload() {
    this.converter = new HeicConverter();

    // Register the file view for .heic files
    this.registerView(VIEW_TYPE_HEIC, (leaf) => new HeicFileView(leaf, this));
    this.registerExtensions(['heic'], VIEW_TYPE_HEIC);

    // MarkdownPostProcessor works in both Reading view and Live Preview
    this.registerMarkdownPostProcessor((el, ctx) => {
      this._processEmbeds(el, ctx);
    });
  }

  onunload() {
    this.converter.destroy();
  }

  // -------------------------------------------------------------------------
  // processEmbeds — shared embed processing logic
  // -------------------------------------------------------------------------
  _processEmbeds(el, ctx) {
    const embeds = el.querySelectorAll('.internal-embed');
    for (const embed of embeds) {
      const src = embed.getAttribute('src');
      if (!src) continue;

      // Check if it's a .heic file
      const linkpath = src.split('|')[0].trim();
      if (!linkpath.toLowerCase().endsWith('.heic')) continue;

      // Skip already processed or in-progress
      if (embed.hasAttribute('data-heic-processing')) continue;
      embed.setAttribute('data-heic-processing', 'true');

      // Resolve the file
      const sourcePath = ctx.sourcePath || '';
      const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (!file) continue;

      // DOM transformation: make it look like an image embed
      embed.removeClass('file-embed');
      embed.addClass('image-embed', 'media-embed');

      // Hide the default file-embed-title
      const title = embed.querySelector('.file-embed-title');
      if (title) title.addClass('heic-preview-hidden');

      // Clear children and add loading indicator
      const existingContent = embed.querySelectorAll(':scope > :not(.file-embed-title)');
      existingContent.forEach(c => c.remove());

      const loading = embed.createDiv({ cls: 'heic-preview-loading', text: 'Converting HEIC…' });

      // Convert asynchronously
      const basePath = this.app.vault.adapter.getBasePath();
      const absPath = path.join(basePath, file.path);
      try {
        const stat = fs.statSync(absPath);
        const mtime = stat.mtimeMs.toString();

        this.converter.convert(absPath, mtime).then((blobURL) => {
          loading.remove();
          const img = embed.createEl('img', { cls: 'heic-preview-img' });
          img.src = blobURL;
          // Support Obsidian's image width syntax ![[file.heic|300]]
          const parts = src.split('|');
          if (parts.length > 1) {
            const width = parseInt(parts[1].trim(), 10);
            if (!isNaN(width)) {
              img.width = width;
            }
          }
        }).catch((e) => {
          loading.remove();
          embed.createDiv({ cls: 'heic-preview-error', text: 'Failed: ' + e.message });
        });
      } catch (e) {
        loading.remove();
        embed.createDiv({ cls: 'heic-preview-error', text: 'Failed: ' + e.message });
      }
    }
  }

}

module.exports = HeicPreviewPlugin;
