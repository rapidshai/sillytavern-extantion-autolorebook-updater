# Smart RAG Lorebook - Work Plan

> This extension was created 100% with AI assistance (Claude Opus).

## Overview

Smart RAG Lorebook is a SillyTavern extension that implements a two-step RAG (Retrieval-Augmented Generation) system for lorebook entries. It compresses long lorebook entries into structured Lite JSON summaries with deep-lore pointers, allowing the main AI to efficiently access relevant information without overwhelming the context window.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Lorebook    │────>│  Worker AI   │────>│  Lite JSON Cache │
│  Entries     │     │  (or Main AI)│     │  (non-destructive)│
│  (READ-ONLY) │     └──────────────┘     └────────┬────────┘
└─────────────┘                                    │
                                                   v
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Main AI    │<────│  Context     │<────│  Lite Context    │
│  Response   │     │  Injection   │     │  + Deep Pointers │
└──────┬──────┘     └──────────────┘     └─────────────────┘
       │
       v  (if [FETCH: #pointer] detected)
┌─────────────┐
│  Deep Lore  │──> Re-inject original content + regenerate
│  Resolution │
└─────────────┘
```

## Key Principles

1. **Non-Destructive**: Original lorebook entries are NEVER modified. All lite data is stored in a separate cache layer and injected alongside the original data.
2. **Additive Context**: Lite JSON summaries are ADDED to the prompt as additional context, they never replace the original lorebook entries.
3. **Dual-Mode Processing**: Entries can be processed by either a dedicated Worker AI (separate endpoint) or the Main AI (SillyTavern's active connection).
4. **Smart Caching**: Content-hash-based caching ensures entries are only re-processed when their content changes.

## Version History

### v1.0.4 (Current)
- Added Main AI processing mode (optional toggle in settings)
- Added progress indicator banner for lorebook entry processing
- Added Worker AI fields auto-hide when Main AI mode is active
- Improved non-destructive architecture documentation
- Added AI attribution
- Created WORKPLAN.md
- Improved JSON parsing robustness

### v1.0.2
- Settings panel with inline drawer UI
- Worker AI connection with configurable endpoint
- Lite JSON cache with TTL and eviction
- Deep lore FETCH system
- Import/Export cache functionality
- Advanced settings (injection position, depth, temperature, etc.)
- Auto-generation on chat start
- Debug mode with console logging

### v1.0.0
- Initial release
- Basic two-step RAG system

## Roadmap / Future Ideas

- [ ] Per-lorebook-book cache isolation
- [ ] Selective entry processing (choose which entries to compress)
- [ ] Multiple AI provider support (built-in presets for Ollama, LM Studio, OpenRouter)
- [ ] Cache statistics dashboard in settings
- [ ] Batch processing with concurrency control
- [ ] Custom JSON schema support for different lorebook types
- [ ] Integration with SillyTavern's built-in vector storage
- [ ] Automatic pointer resolution without [FETCH] command (proactive injection)

## File Structure

```
sillytavern-extension-autolorebook-updater/
├── index.js          # Main extension logic
├── style.css         # UI styles (settings panel + progress banner)
├── manifest.json     # SillyTavern extension manifest
├── WORKPLAN.md       # This file - development plan and documentation
└── README.md         # (future) User-facing documentation
```

## Technical Notes

### SillyTavern Extension API Used
- `SillyTavern.getContext()` - Access to chat, settings, generation functions
- `context.setExtensionPrompt()` - Inject content into the AI prompt
- `context.generateQuietPrompt()` - Generate AI response without affecting chat (Main AI mode)
- `extension_settings[name]` - Persistent extension settings storage
- `saveSettingsDebounced()` - Debounced settings persistence
- `eventSource.on()` - Event hooks (GENERATION_STARTED, MESSAGE_RECEIVED, CHAT_CHANGED)

### Cache Key Format
`{entry_uid}_{content_hash}` - Content hash ensures entries are re-processed when their content changes, while the UID prefix allows efficient lookup per entry.
