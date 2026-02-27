# HEIC Preview — Obsidian Plugin

Preview HEIC images natively on macOS using hardware-accelerated `sips`.

## Why

macOS 硬件解码 HEIC 只需 ~200ms，但 Image Magician 插件用 magick-wasm 纯软件解码，慢 5-10 倍且阻塞 UI。本插件通过 `child_process.execFile` 调用 macOS 原生 `sips` 命令做硬件加速 HEIC→JPEG 转换，实现流畅预览。

## Features

- `![[*.heic]]` 嵌入预览（阅读视图 + 编辑视图）
- 直接打开 `.heic` 文件的独立视图
- 三级缓存（内存 → 磁盘 → sips 转换）
- 并发控制（MAX_CONCURRENT = 3）
- 仅限 macOS Desktop

## Architecture

```
HeicPreviewPlugin (Plugin)
├── HeicConverter           // sips 调用 + 三级缓存 + 并发控制
├── processEmbeds()         // 处理 ![[*.heic]] 嵌入（读和编辑视图共用）
├── MarkdownPostProcessor   // 阅读视图
├── LivePreview Extension   // 编辑视图 (CodeMirror ViewPlugin)
└── HeicFileView            // 直接打开 .heic 文件的视图
```

### 三级缓存

```
convert(absPath, mtime)
  → [1] 内存缓存 (Map<path:mtime, blobURL>)  → 命中: ~0ms
  → [2] 磁盘缓存 (/tmp/obsidian-heic-preview/<md5>.jpg) → 命中: ~5ms
  → [3] execFile sips → ~200ms（硬件加速，异步非阻塞）
  → 写入磁盘缓存 + 内存缓存 → 返回 blobURL
```

## Installation

1. 将 `manifest.json`、`main.js`、`styles.css` 放入 `<vault>/.obsidian/plugins/heic-preview/`
2. 在 `<vault>/.obsidian/community-plugins.json` 数组末尾添加 `"heic-preview"`
3. 重启 Obsidian，在设置中启用插件

## Development

```bash
# 开发时直接编辑 main.js（无构建步骤）
# 测试：重启 Obsidian 或 Ctrl+R 重新加载
```

## License

MIT
