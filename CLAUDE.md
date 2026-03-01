# CLAUDE.md — heic-preview Obsidian Plugin

## Project Overview

macOS-only Obsidian 插件，通过 `child_process.execFile` 调用原生 `sips` 命令实现 HEIC 图片硬件加速预览。

## Directory Layout

```
~/claude/obsidian-heic-preview/             # Development repo (this directory)
├── CLAUDE.md
├── README.md
├── manifest.json
├── main.js            # 插件主逻辑（plain JS, no build step）
└── styles.css

$WIKI/.obsidian/plugins/heic-preview/       # Runtime install in vault
├── main.js
├── manifest.json
└── styles.css
```

`$WIKI` resolves to `~/OneDrive/wiki/`.

## Development Workflow

1. Edit code in `~/claude/obsidian-heic-preview/`.
2. Deploy to vault for testing:
   ```bash
   mkdir -p ~/OneDrive/wiki/.obsidian/plugins/heic-preview/
   cp ~/claude/obsidian-heic-preview/{main.js,manifest.json,styles.css} ~/OneDrive/wiki/.obsidian/plugins/heic-preview/
   ```
3. First-time setup: add `"heic-preview"` to `~/OneDrive/wiki/.obsidian/community-plugins.json`.
4. In Obsidian: disable then re-enable **HEIC Preview** in `Settings → Community Plugins` (or restart Obsidian) to reload.
5. Test: embed `![[xxx.heic]]` in a note, and click a `.heic` file directly.
6. Commit to git in `~/claude/obsidian-heic-preview/`.

## Implementation Plan

### manifest.json

```json
{
  "id": "heic-preview",
  "name": "HEIC Preview",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Preview HEIC images natively on macOS using hardware-accelerated sips.",
  "author": "Lalo",
  "isDesktopOnly": true
}
```

### main.js 核心架构

```
HeicPreviewPlugin (Plugin)
├── HeicConverter           // sips 调用 + 三级缓存 + 并发控制
├── processEmbeds()         // 处理 ![[*.heic]] 嵌入（读和编辑视图共用）
├── MarkdownPostProcessor   // 阅读视图
├── LivePreview Extension   // 编辑视图 (CodeMirror ViewPlugin)
└── HeicFileView            // 直接打开 .heic 文件的视图
```

#### HeicConverter 三级缓存

```
convert(absPath, mtime)
  → [1] 内存缓存 (Map<path:mtime, blobURL>)  → 命中: ~0ms
  → [2] 磁盘缓存 (/tmp/obsidian-heic-preview/<md5>.jpg) → 命中: ~5ms
  → [3] execFile sips → ~200ms（硬件加速，异步非阻塞）
  → 写入磁盘缓存 + 内存缓存 → 返回 blobURL
```

- 并发限制 MAX_CONCURRENT = 3
- inflight Map 去重（同一文件不重复转换）
- mtime 变化自动失效缓存
- 用 `execFile`（非 `exec`）避免 shell 注入

#### processEmbeds() 处理流程

1. 查询 `.internal-embed` 元素，提取 `src` 属性
2. 通过 `app.metadataCache.getFirstLinkpathDest()` 解析为 TFile
3. 检查扩展名是 `.heic`，跳过已处理的
4. DOM 改造：移除 `file-embed` 类，加 `image-embed` + `media-embed`
5. 创建 `<img>` 元素，显示 loading 占位
6. 调用 converter.convert()，完成后设置 img.src = blobURL

### styles.css

- `.heic-preview-img` — max-width: 100%
- `.heic-preview-loading` — 居中灰色文字
- `.heic-preview-error` — 红色错误提示
- `.heic-preview-hidden` — 隐藏默认的 file-embed-title

## Key Technical Details

### Obsidian Plugin API

```js
const { Plugin, FileView, ItemView } = require('obsidian');
const { execFile } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
```

- `Plugin` 基类提供 `onload()` / `onunload()` 生命周期
- `this.registerMarkdownPostProcessor()` 注册阅读视图后处理器
- `this.registerEditorExtension()` 注册 CodeMirror 扩展（编辑视图）
- `this.registerView()` 注册自定义文件视图
- `this.registerExtensions()` 将 `.heic` 文件类型关联到自定义视图
- `this.app.vault.adapter.getBasePath()` 获取 vault 根目录绝对路径

### sips 命令

```bash
sips -s format jpeg -s formatOptions 85 --resampleHeightWidthMax 2048 INPUT -o OUTPUT
```

- `-s format jpeg` — 输出 JPEG
- `-s formatOptions 85` — JPEG 质量 85%
- `--resampleHeightWidthMax 2048` — 限制最大边 2048px（避免巨图）
- 用 `execFile` 调用，参数数组传入，不经过 shell

### 磁盘缓存

- 目录: `/tmp/obsidian-heic-preview/`
- 文件名: `md5(absPath).jpg`
- 缓存键: `absPath + ':' + mtime`（mtime 变化则重新转换）
- 插件 unload 时不清理磁盘缓存（跨会话复用）
- 内存中的 blobURL 在 unload 时 `URL.revokeObjectURL()` 释放

## Verification Checklist

1. 重启 Obsidian，确认 heic-preview 出现在已安装插件列表中
2. 新建笔记，输入 `![[某个.heic文件]]`，确认图片能正常预览
3. 在文件浏览器中直接点击 .heic 文件，确认能在标签页中打开预览
4. 打开包含多张 HEIC 图片的笔记，确认不卡顿
5. 检查 `/tmp/obsidian-heic-preview/` 目录，确认有缓存的 .jpg 文件
