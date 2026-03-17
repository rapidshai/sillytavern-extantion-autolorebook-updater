/*
 * Smart RAG Lorebook - SillyTavern Extension
 *
 * Two-step RAG system for Lorebook entries:
 * 1. Worker AI compresses lorebook entries into Lite JSON format with pointers
 * 2. Main AI receives Lite context and can [FETCH: #pointer] for deep lore on demand
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

// ============================================================================
// Constants
// ============================================================================

const EXTENSION_NAME = 'smart-rag-lorebook';
const EXTENSION_FOLDER = `third_party/${EXTENSION_NAME}`;

const DEFAULT_SETTINGS = {
    // Basic
    enabled: true,
    worker_endpoint: 'http://localhost:11434/v1/chat/completions',
    worker_model: 'llama3:8b',
    worker_api_key: '',
    auto_generate: true,
    inject_system_prompt: true,
    // Advanced: Cache & Saving
    save_interval: 30,
    cache_ttl: 0,
    max_cache_entries: 500,
    // Advanced: Content Thresholds
    min_content_length: 500,
    max_lite_entries: 50,
    // Advanced: Worker AI Tuning
    worker_temperature: 0.2,
    worker_max_tokens: 1024,
    worker_timeout: 60,
    // Advanced: Injection
    injection_position: 0,
    injection_depth: 4,
    // Advanced: Deep Fetch
    max_fetch_depth: 3,
    show_fetch_toast: true,
    // Advanced: Debug
    debug_mode: false,
    // Internal
    lite_cache: {},
};

const WORKER_SYSTEM_PROMPT = `You are an expert data extractor for a roleplay engine. Your task is to analyze the provided lorebook entry and compress it into a highly efficient JSON format.

Rules:
1. Extract the absolute core details into short, comma-separated tags under quick_attributes.
2. For any deep, lengthy, or complex information (like history, detailed relationships, or complex rules), DO NOT include the full text. Instead, create a pointer in the deep_pointers array.
3. A pointer must have a pointer_tag starting with # (e.g., #Alice_History) and a very brief hint explaining what information is stored behind that tag.
4. Output ONLY valid JSON matching the exact schema provided. Do not add conversational text.

Schema:
{
  "entity_name": "Name of the character or concept",
  "entity_type": "Character | Location | Lore | Item",
  "core_identity": "One to two sentences summarizing the essence.",
  "quick_attributes": {
    "personality": ["trait1", "trait2", "trait3"],
    "appearance": ["feature1", "feature2"],
    "speech_style": ["style or limitation"]
  },
  "deep_pointers": [
    {
      "pointer_tag": "#Entity_Topic",
      "hint": "Brief hint about what info is stored here"
    }
  ]
}`;

const MAIN_AI_SYSTEM_INJECTION = `### DYNAMIC MEMORY SYSTEM ###
You have access to a dynamic external memory system to save context space.
Throughout the conversation, you may receive <Lite_Context> blocks containing brief summaries of characters, locations, or lore.
Inside these blocks, you will see "Available Deep Lore" with specific pointers starting with a hashtag (e.g., #Alice_History).

RULES FOR FETCHING MEMORY:
1. If the user asks a question or creates a scenario that requires deep knowledge you currently lack, DO NOT hallucinate or invent facts.
2. If a relevant pointer exists in the <Lite_Context>, you must request the full information by outputting the exact tag wrapped in a fetch command, like this:
    [FETCH: #Pointer_Name]
3. Stop generating your response immediately after outputting the [FETCH] command. The system will invisibly provide you with the deep lore and prompt you to continue seamlessly.`;

// ============================================================================
// State
// ============================================================================

let pendingDeepFetchContent = null;
let isRegenerating = false;
let currentFetchDepth = 0;
let activePointerMap = {};
let autoSaveTimerId = null;
let pendingSave = false;

// ============================================================================
// Debug Logging
// ============================================================================

function debugLog(...args) {
    if (getSettings().debug_mode) {
        console.log('[SmartRAG]', ...args);
    }
}

// ============================================================================
// Settings Management
// ============================================================================

function loadSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXTENSION_NAME][key] === undefined) {
            extension_settings[EXTENSION_NAME][key] = value;
        }
    }

    syncUIFromSettings();
}

function syncUIFromSettings() {
    const s = extension_settings[EXTENSION_NAME];

    // Basic
    $('#smart_rag_enabled').prop('checked', s.enabled);
    $('#smart_rag_worker_endpoint').val(s.worker_endpoint);
    $('#smart_rag_worker_model').val(s.worker_model);
    $('#smart_rag_worker_api_key').val(s.worker_api_key);
    $('#smart_rag_auto_generate').prop('checked', s.auto_generate);
    $('#smart_rag_inject_system_prompt').prop('checked', s.inject_system_prompt);

    // Advanced: Cache & Saving
    $('#smart_rag_save_interval').val(s.save_interval);
    $('#smart_rag_cache_ttl').val(s.cache_ttl);
    $('#smart_rag_max_cache_entries').val(s.max_cache_entries);

    // Advanced: Content Thresholds
    $('#smart_rag_min_content_length').val(s.min_content_length);
    $('#smart_rag_max_lite_entries').val(s.max_lite_entries);

    // Advanced: Worker AI Tuning
    $('#smart_rag_worker_temperature').val(s.worker_temperature);
    $('#smart_rag_worker_temperature_value').text(s.worker_temperature);
    $('#smart_rag_worker_max_tokens').val(s.worker_max_tokens);
    $('#smart_rag_worker_timeout').val(s.worker_timeout);

    // Advanced: Injection
    $('#smart_rag_injection_position').val(s.injection_position);
    $('#smart_rag_injection_depth').val(s.injection_depth);
    updateDepthRowVisibility(s.injection_position);

    // Advanced: Deep Fetch
    $('#smart_rag_max_fetch_depth').val(s.max_fetch_depth);
    $('#smart_rag_show_fetch_toast').prop('checked', s.show_fetch_toast);

    // Advanced: Debug
    $('#smart_rag_debug_mode').prop('checked', s.debug_mode);
}

function saveSettings() {
    const s = extension_settings[EXTENSION_NAME];

    // Basic
    s.enabled = $('#smart_rag_enabled').is(':checked');
    s.worker_endpoint = $('#smart_rag_worker_endpoint').val().trim();
    s.worker_model = $('#smart_rag_worker_model').val().trim();
    s.worker_api_key = $('#smart_rag_worker_api_key').val().trim();
    s.auto_generate = $('#smart_rag_auto_generate').is(':checked');
    s.inject_system_prompt = $('#smart_rag_inject_system_prompt').is(':checked');

    // Advanced: Cache & Saving
    s.save_interval = parseInt($('#smart_rag_save_interval').val()) || 30;
    s.cache_ttl = parseInt($('#smart_rag_cache_ttl').val()) || 0;
    s.max_cache_entries = parseInt($('#smart_rag_max_cache_entries').val()) || 500;

    // Advanced: Content Thresholds
    s.min_content_length = parseInt($('#smart_rag_min_content_length').val()) || 500;
    s.max_lite_entries = parseInt($('#smart_rag_max_lite_entries').val()) || 50;

    // Advanced: Worker AI Tuning
    s.worker_temperature = parseFloat($('#smart_rag_worker_temperature').val()) || 0.2;
    s.worker_max_tokens = parseInt($('#smart_rag_worker_max_tokens').val()) || 1024;
    s.worker_timeout = parseInt($('#smart_rag_worker_timeout').val()) || 60;

    // Advanced: Injection
    s.injection_position = parseInt($('#smart_rag_injection_position').val()) || 0;
    s.injection_depth = parseInt($('#smart_rag_injection_depth').val()) || 4;

    // Advanced: Deep Fetch
    s.max_fetch_depth = parseInt($('#smart_rag_max_fetch_depth').val()) || 3;
    s.show_fetch_toast = $('#smart_rag_show_fetch_toast').is(':checked');

    // Advanced: Debug
    s.debug_mode = $('#smart_rag_debug_mode').is(':checked');

    scheduleSave();
}

function getSettings() {
    return extension_settings[EXTENSION_NAME] || DEFAULT_SETTINGS;
}

// ============================================================================
// Auto-Save Timer
// ============================================================================

function scheduleSave() {
    const settings = getSettings();

    if (settings.save_interval <= 0) {
        saveSettingsDebounced();
        return;
    }

    pendingSave = true;

    if (!autoSaveTimerId) {
        autoSaveTimerId = setInterval(() => {
            if (pendingSave) {
                saveSettingsDebounced();
                pendingSave = false;
                debugLog('Auto-saved settings');
            }
        }, settings.save_interval * 1000);
    }
}

function stopAutoSave() {
    if (autoSaveTimerId) {
        clearInterval(autoSaveTimerId);
        autoSaveTimerId = null;
    }
    if (pendingSave) {
        saveSettingsDebounced();
        pendingSave = false;
    }
}

// ============================================================================
// Worker AI Communication
// ============================================================================

async function callWorkerAI(entryContent, entryName) {
    const settings = getSettings();

    const requestBody = {
        model: settings.worker_model,
        messages: [
            { role: 'system', content: WORKER_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Lorebook entry name: "${entryName}"\n\nFull content:\n${entryContent}`,
            },
        ],
        temperature: settings.worker_temperature,
        max_tokens: settings.worker_max_tokens,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (settings.worker_api_key) {
        headers['Authorization'] = `Bearer ${settings.worker_api_key}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), settings.worker_timeout * 1000);

    try {
        const response = await fetch(settings.worker_endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[SmartRAG] Worker API error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            console.error('[SmartRAG] Worker returned empty content');
            return null;
        }

        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        const jsonStr = jsonMatch[1].trim();
        const parsed = JSON.parse(jsonStr);

        debugLog('Worker AI result for', entryName, ':', parsed);
        return parsed;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error(`[SmartRAG] Worker AI request timed out after ${settings.worker_timeout}s`);
        } else {
            console.error('[SmartRAG] Worker AI call failed:', err);
        }
        return null;
    }
}

async function testWorkerConnection() {
    const statusEl = $('#smart_rag_status');
    statusEl.text('Testing connection...').attr('class', 'smart-rag-status info');

    try {
        const result = await callWorkerAI(
            'Alice is a powerful mage who lives in a dark tower. She has black hair and glowing eyes. She lost her family at age 10 when raiders destroyed her village.',
            'Test Entry',
        );

        if (result && result.entity_name) {
            statusEl.text(`Connection OK! Got: ${result.entity_name} (${result.entity_type})`).attr('class', 'smart-rag-status success');
        } else {
            statusEl.text('Connection succeeded but response format is unexpected.').attr('class', 'smart-rag-status error');
        }
    } catch (err) {
        statusEl.text(`Connection failed: ${err.message}`).attr('class', 'smart-rag-status error');
    }
}

// ============================================================================
// Lite Cache Management
// ============================================================================

function getLiteCache() {
    const settings = getSettings();
    if (!settings.lite_cache) {
        settings.lite_cache = {};
    }
    return settings.lite_cache;
}

function hashContent(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(36);
}

/**
 * Evicts expired and over-limit cache entries.
 */
function evictCache() {
    const settings = getSettings();
    const cache = getLiteCache();
    const keys = Object.keys(cache);

    // Evict by TTL
    if (settings.cache_ttl > 0) {
        const now = Date.now();
        const ttlMs = settings.cache_ttl * 3600 * 1000;
        for (const key of keys) {
            const entry = cache[key];
            if (entry && entry._cached_at && (now - entry._cached_at) > ttlMs) {
                delete cache[key];
                debugLog('Evicted expired cache entry:', key);
            }
        }
    }

    // Evict by count (remove oldest first)
    const remaining = Object.keys(cache);
    if (remaining.length > settings.max_cache_entries) {
        const sorted = remaining.sort((a, b) => {
            const aTime = cache[a]?._cached_at || 0;
            const bTime = cache[b]?._cached_at || 0;
            return aTime - bTime;
        });
        const toRemove = sorted.slice(0, remaining.length - settings.max_cache_entries);
        for (const key of toRemove) {
            delete cache[key];
            debugLog('Evicted over-limit cache entry:', key);
        }
    }
}

async function getOrGenerateLite(uid, content, name) {
    const settings = getSettings();
    const cache = getLiteCache();
    const contentHash = hashContent(content);
    const cacheKey = `${uid}_${contentHash}`;

    if (cache[cacheKey]) {
        // Check TTL if set
        if (settings.cache_ttl > 0) {
            const ttlMs = settings.cache_ttl * 3600 * 1000;
            if (cache[cacheKey]._cached_at && (Date.now() - cache[cacheKey]._cached_at) > ttlMs) {
                delete cache[cacheKey];
                debugLog('Cache expired for:', name);
            } else {
                return cache[cacheKey];
            }
        } else {
            return cache[cacheKey];
        }
    }

    if (content.length < settings.min_content_length) {
        return null;
    }

    toastr.info(`Generating Lite Context for: ${name}`, 'Smart RAG', { timeOut: 3000 });
    const liteJson = await callWorkerAI(content, name);

    if (liteJson) {
        // Clear old hashes for this uid
        for (const key of Object.keys(cache)) {
            if (key.startsWith(`${uid}_`)) {
                delete cache[key];
            }
        }
        liteJson._cached_at = Date.now();
        cache[cacheKey] = liteJson;
        evictCache();
        scheduleSave();
    }

    return liteJson;
}

// ============================================================================
// Lite Context Formatting
// ============================================================================

function formatLiteContext(liteJson) {
    const attrs = liteJson.quick_attributes || {};
    const lines = [];

    lines.push(`<Lite_Context: ${liteJson.entity_name}>`);
    lines.push(`Type: ${liteJson.entity_type}`);
    lines.push(`Core: ${liteJson.core_identity}`);

    const attrParts = [];
    if (attrs.personality?.length) attrParts.push(`[Personality: ${attrs.personality.join(', ')}]`);
    if (attrs.appearance?.length) attrParts.push(`[Appearance: ${attrs.appearance.join(', ')}]`);
    if (attrs.speech_style?.length) attrParts.push(`[Speech: ${attrs.speech_style.join(', ')}]`);

    for (const [key, val] of Object.entries(attrs)) {
        if (!['personality', 'appearance', 'speech_style'].includes(key) && Array.isArray(val)) {
            attrParts.push(`[${key}: ${val.join(', ')}]`);
        }
    }

    if (attrParts.length) {
        lines.push(`Attributes: ${attrParts.join(' ')}`);
    }

    const pointers = liteJson.deep_pointers || [];
    if (pointers.length) {
        lines.push('Available Deep Lore (Request using tag if needed):');
        for (const p of pointers) {
            lines.push(`  - ${p.pointer_tag}: ${p.hint}`);
        }
    }

    lines.push(`</Lite_Context>`);
    return lines.join('\n');
}

// ============================================================================
// World Info / Lorebook Access
// ============================================================================

function getWorldInfoEntries() {
    const context = getContext();
    const entries = [];

    if (context.worldInfo) {
        for (const [uid, entry] of Object.entries(context.worldInfo)) {
            if (entry && entry.content && !entry.disable) {
                entries.push({
                    uid,
                    name: entry.comment || entry.key?.[0] || `Entry_${uid}`,
                    content: entry.content,
                    keys: entry.key || [],
                    originalEntry: entry,
                });
            }
        }
    }

    return entries;
}

function resolvePointer(pointerTag) {
    const pointerInfo = activePointerMap[pointerTag];
    if (!pointerInfo) {
        console.warn(`[SmartRAG] Unknown pointer: ${pointerTag}`);
        return null;
    }

    const entries = getWorldInfoEntries();
    const entry = entries.find(e => e.uid === pointerInfo.entryUid);
    if (!entry) {
        console.warn(`[SmartRAG] Entry not found for pointer: ${pointerTag}`);
        return null;
    }

    return entry.content;
}

// ============================================================================
// Context Injection (Step 3)
// ============================================================================

async function onGenerationStarted(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;

    activePointerMap = {};

    const entries = getWorldInfoEntries();
    const liteBlocks = [];
    let count = 0;

    for (const entry of entries) {
        if (count >= settings.max_lite_entries) break;

        const liteJson = await getOrGenerateLite(entry.uid, entry.content, entry.name);

        if (liteJson) {
            if (liteJson.deep_pointers) {
                for (const pointer of liteJson.deep_pointers) {
                    activePointerMap[pointer.pointer_tag] = {
                        entryUid: entry.uid,
                        sectionHint: pointer.hint,
                    };
                }
            }
            liteBlocks.push(formatLiteContext(liteJson));
            count++;
        }
    }

    if (liteBlocks.length > 0) {
        const liteContent = '<Available_Knowledge>\n' + liteBlocks.join('\n\n') + '\n</Available_Knowledge>';
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_lite',
                liteContent,
                settings.injection_position,
                settings.injection_depth,
            );
        }
        debugLog(`Injected ${liteBlocks.length} Lite contexts at position ${settings.injection_position}`);
    }

    if (settings.inject_system_prompt) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_system',
                MAIN_AI_SYSTEM_INJECTION,
                1, // BEFORE_PROMPT
                0,
            );
        }
    }

    if (pendingDeepFetchContent) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_deep',
                `<Deep_Lore_Response>\n${pendingDeepFetchContent}\n</Deep_Lore_Response>\nNow continue your response seamlessly using the deep lore above. Do not mention the fetch system.`,
                settings.injection_position,
                settings.injection_depth,
            );
        }
        pendingDeepFetchContent = null;
        isRegenerating = false;
    }
}

// ============================================================================
// FETCH Interception (Step 4)
// ============================================================================

async function onMessageReceived(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || isRegenerating) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return;

    const message = chat[messageIndex];
    if (!message || message.is_user) return;

    const text = message.mes || '';

    const fetchMatch = text.match(/\[FETCH:\s*(#[\w_]+)\s*\]/);
    if (!fetchMatch) {
        currentFetchDepth = 0;
        return;
    }

    // Loop protection
    currentFetchDepth++;
    if (currentFetchDepth > settings.max_fetch_depth) {
        console.warn(`[SmartRAG] Max fetch depth (${settings.max_fetch_depth}) reached, stopping.`);
        toastr.warning(`Max FETCH depth reached (${settings.max_fetch_depth}). Stopping to prevent loops.`, 'Smart RAG');
        currentFetchDepth = 0;
        return;
    }

    const pointerTag = fetchMatch[1];
    debugLog(`Detected FETCH request for: ${pointerTag} (depth ${currentFetchDepth})`);

    const deepContent = resolvePointer(pointerTag);
    if (!deepContent) {
        console.warn(`[SmartRAG] Could not resolve pointer: ${pointerTag}`);
        toastr.warning(`Could not resolve pointer: ${pointerTag}`, 'Smart RAG');
        currentFetchDepth = 0;
        return;
    }

    pendingDeepFetchContent = `[Deep Lore for ${pointerTag}]\n${deepContent}`;
    isRegenerating = true;

    if (settings.show_fetch_toast) {
        toastr.info(`Fetching deep lore: ${pointerTag}`, 'Smart RAG', { timeOut: 2000 });
    }

    if (typeof context.deleteMessageByIndex === 'function') {
        await context.deleteMessageByIndex(messageIndex);
    } else {
        chat.splice(messageIndex, 1);
        $(`.mes[mesid="${messageIndex}"]`).remove();
    }

    if (typeof context.generate === 'function') {
        await context.generate('normal');
    } else {
        $('#option_regenerate').trigger('click');
    }
}

// ============================================================================
// Bulk Operations
// ============================================================================

async function generateAllLiteEntries() {
    const settings = getSettings();
    if (!settings.worker_endpoint || !settings.worker_model) {
        toastr.error('Please configure Worker AI endpoint and model first.', 'Smart RAG');
        return;
    }

    const entries = getWorldInfoEntries();
    const statusEl = $('#smart_rag_status');

    if (entries.length === 0) {
        statusEl.text('No active lorebook entries found.').attr('class', 'smart-rag-status info');
        return;
    }

    let generated = 0;
    let skipped = 0;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        statusEl.text(`Processing ${i + 1}/${entries.length}: ${entry.name}...`).attr('class', 'smart-rag-status info');

        if (entry.content.length < settings.min_content_length) {
            skipped++;
            continue;
        }

        const result = await getOrGenerateLite(entry.uid, entry.content, entry.name);
        if (result) generated++;
    }

    statusEl.text(`Done! Generated: ${generated}, Skipped (too short): ${skipped}`).attr('class', 'smart-rag-status success');
    toastr.success(`Generated ${generated} Lite entries (${skipped} skipped)`, 'Smart RAG');
}

function clearLiteCache() {
    const settings = getSettings();
    settings.lite_cache = {};
    saveSettingsDebounced();
    activePointerMap = {};
    toastr.info('Lite cache cleared.', 'Smart RAG');
    $('#smart_rag_status').text('Cache cleared.').attr('class', 'smart-rag-status info');
}

// ============================================================================
// Cache Import / Export
// ============================================================================

function exportCache() {
    const cache = getLiteCache();
    const count = Object.keys(cache).length;

    if (count === 0) {
        toastr.info('Cache is empty, nothing to export.', 'Smart RAG');
        return;
    }

    const blob = new Blob([JSON.stringify(cache, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-rag-cache-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${count} cache entries.`, 'Smart RAG');
}

function importCache() {
    $('#smart_rag_import_file').trigger('click');
}

function handleImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (typeof imported !== 'object' || Array.isArray(imported)) {
                throw new Error('Invalid format');
            }

            const settings = getSettings();
            const cache = getLiteCache();
            let count = 0;

            for (const [key, value] of Object.entries(imported)) {
                if (value && typeof value === 'object' && value.entity_name) {
                    cache[key] = value;
                    count++;
                }
            }

            evictCache();
            saveSettingsDebounced();
            toastr.success(`Imported ${count} cache entries.`, 'Smart RAG');
            $('#smart_rag_status').text(`Imported ${count} entries.`).attr('class', 'smart-rag-status success');
        } catch (err) {
            toastr.error(`Import failed: ${err.message}`, 'Smart RAG');
        }
    };
    reader.readAsText(file);

    // Reset so same file can be re-imported
    event.target.value = '';
}

// ============================================================================
// Chat Change Handler
// ============================================================================

async function onChatChanged() {
    const settings = getSettings();
    if (!settings.enabled || !settings.auto_generate) return;

    await new Promise(r => setTimeout(r, 1000));

    const entries = getWorldInfoEntries();
    let needsGeneration = false;

    for (const entry of entries) {
        if (entry.content.length >= settings.min_content_length) {
            const cache = getLiteCache();
            const contentHash = hashContent(entry.content);
            const cacheKey = `${entry.uid}_${contentHash}`;
            if (!cache[cacheKey]) {
                needsGeneration = true;
                break;
            }
        }
    }

    if (needsGeneration) {
        debugLog('Auto-generating Lite entries for new chat...');
        await generateAllLiteEntries();
    }
}

// ============================================================================
// UI Helpers
// ============================================================================

function updateDepthRowVisibility(positionValue) {
    const depthRow = $('#smart_rag_depth_row');
    if (parseInt(positionValue) === 4) {
        depthRow.removeClass('hidden');
    } else {
        depthRow.addClass('hidden');
    }
}

function toggleAdvancedSettings() {
    const toggle = $('#smart_rag_advanced_toggle');
    const content = $('#smart_rag_advanced_content');
    toggle.toggleClass('open');
    content.toggleClass('open');
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async () => {
    const settingsHtml = await $.get(`${EXTENSION_FOLDER}/index.html`);
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();

    // === Basic settings bindings ===
    $('#smart_rag_enabled').on('change', saveSettings);
    $('#smart_rag_worker_endpoint').on('input', saveSettings);
    $('#smart_rag_worker_model').on('input', saveSettings);
    $('#smart_rag_worker_api_key').on('input', saveSettings);
    $('#smart_rag_auto_generate').on('change', saveSettings);
    $('#smart_rag_inject_system_prompt').on('change', saveSettings);

    // === Advanced settings bindings ===
    $('#smart_rag_save_interval').on('input', () => {
        stopAutoSave();
        saveSettings();
    });
    $('#smart_rag_cache_ttl').on('input', saveSettings);
    $('#smart_rag_max_cache_entries').on('input', saveSettings);
    $('#smart_rag_min_content_length').on('input', saveSettings);
    $('#smart_rag_max_lite_entries').on('input', saveSettings);
    $('#smart_rag_worker_temperature').on('input', function () {
        $('#smart_rag_worker_temperature_value').text($(this).val());
        saveSettings();
    });
    $('#smart_rag_worker_max_tokens').on('input', saveSettings);
    $('#smart_rag_worker_timeout').on('input', saveSettings);
    $('#smart_rag_injection_position').on('change', function () {
        updateDepthRowVisibility($(this).val());
        saveSettings();
    });
    $('#smart_rag_injection_depth').on('input', saveSettings);
    $('#smart_rag_max_fetch_depth').on('input', saveSettings);
    $('#smart_rag_show_fetch_toast').on('change', saveSettings);
    $('#smart_rag_debug_mode').on('change', saveSettings);

    // === Button handlers ===
    $('#smart_rag_generate_all').on('click', generateAllLiteEntries);
    $('#smart_rag_clear_cache').on('click', clearLiteCache);
    $('#smart_rag_test_worker').on('click', testWorkerConnection);
    $('#smart_rag_export_cache').on('click', exportCache);
    $('#smart_rag_import_cache').on('click', importCache);
    $('#smart_rag_import_file').on('change', handleImportFile);

    // === Advanced spoiler toggle ===
    $('#smart_rag_advanced_toggle').on('click', toggleAdvancedSettings);

    // === Depth row visibility on load ===
    updateDepthRowVisibility(getSettings().injection_position);

    // === Event hooks ===
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[SmartRAG] Smart RAG Lorebook extension loaded.');
});
