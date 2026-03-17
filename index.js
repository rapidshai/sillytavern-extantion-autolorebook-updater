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
const LITE_CACHE_KEY = 'smart_rag_lite_cache';

const DEFAULT_SETTINGS = {
    enabled: true,
    worker_endpoint: 'http://localhost:11434/v1/chat/completions',
    worker_model: 'llama3:8b',
    worker_api_key: '',
    min_content_length: 500,
    auto_generate: true,
    inject_system_prompt: true,
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

/** Currently active deep-fetch content injected for regeneration */
let pendingDeepFetchContent = null;

/** Flag to track if we're in a regeneration cycle from a FETCH intercept */
let isRegenerating = false;

/** Map of pointer_tag -> { entryUid, sectionHint } for resolving FETCH requests */
let activePointerMap = {};

// ============================================================================
// Settings Management
// ============================================================================

function loadSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }

    // Apply defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXTENSION_NAME][key] === undefined) {
            extension_settings[EXTENSION_NAME][key] = value;
        }
    }

    // Sync UI
    const s = extension_settings[EXTENSION_NAME];
    $('#smart_rag_enabled').prop('checked', s.enabled);
    $('#smart_rag_worker_endpoint').val(s.worker_endpoint);
    $('#smart_rag_worker_model').val(s.worker_model);
    $('#smart_rag_worker_api_key').val(s.worker_api_key);
    $('#smart_rag_min_content_length').val(s.min_content_length);
    $('#smart_rag_auto_generate').prop('checked', s.auto_generate);
    $('#smart_rag_inject_system_prompt').prop('checked', s.inject_system_prompt);
}

function saveSettings() {
    const s = extension_settings[EXTENSION_NAME];
    s.enabled = $('#smart_rag_enabled').is(':checked');
    s.worker_endpoint = $('#smart_rag_worker_endpoint').val().trim();
    s.worker_model = $('#smart_rag_worker_model').val().trim();
    s.worker_api_key = $('#smart_rag_worker_api_key').val().trim();
    s.min_content_length = parseInt($('#smart_rag_min_content_length').val()) || 500;
    s.auto_generate = $('#smart_rag_auto_generate').is(':checked');
    s.inject_system_prompt = $('#smart_rag_inject_system_prompt').is(':checked');
    saveSettingsDebounced();
}

function getSettings() {
    return extension_settings[EXTENSION_NAME] || DEFAULT_SETTINGS;
}

// ============================================================================
// Worker AI Communication
// ============================================================================

/**
 * Calls the Worker AI with an OpenAI-compatible API to generate Lite JSON
 * from a full lorebook entry.
 *
 * @param {string} entryContent - Full text content of the lorebook entry
 * @param {string} entryName - Name/comment of the entry (for context)
 * @returns {object|null} Parsed Lite JSON object or null on failure
 */
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
        temperature: 0.2,
        max_tokens: 1024,
    };

    const headers = {
        'Content-Type': 'application/json',
    };

    if (settings.worker_api_key) {
        headers['Authorization'] = `Bearer ${settings.worker_api_key}`;
    }

    try {
        const response = await fetch(settings.worker_endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
        });

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

        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        const jsonStr = jsonMatch[1].trim();

        const parsed = JSON.parse(jsonStr);
        return parsed;
    } catch (err) {
        console.error('[SmartRAG] Worker AI call failed:', err);
        return null;
    }
}

/**
 * Tests the Worker AI connection with a simple request.
 */
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

/**
 * Gets the lite cache from extension settings.
 * Cache is keyed by a hash of entry content for invalidation.
 */
function getLiteCache() {
    const settings = getSettings();
    if (!settings.lite_cache) {
        settings.lite_cache = {};
    }
    return settings.lite_cache;
}

/**
 * Simple string hash for cache invalidation.
 */
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
 * Gets or generates a Lite version for a lorebook entry.
 *
 * @param {string} uid - Unique identifier for the entry
 * @param {string} content - Full entry content
 * @param {string} name - Entry name/comment
 * @returns {object|null} Lite JSON or null
 */
async function getOrGenerateLite(uid, content, name) {
    const settings = getSettings();
    const cache = getLiteCache();
    const contentHash = hashContent(content);
    const cacheKey = `${uid}_${contentHash}`;

    // Return cached version if content hasn't changed
    if (cache[cacheKey]) {
        return cache[cacheKey];
    }

    // Skip if content is too short
    if (content.length < settings.min_content_length) {
        return null;
    }

    // Generate via Worker AI
    toastr.info(`Generating Lite Context for: ${name}`, 'Smart RAG', { timeOut: 3000 });
    const liteJson = await callWorkerAI(content, name);

    if (liteJson) {
        // Clear old cache entries for this uid
        for (const key of Object.keys(cache)) {
            if (key.startsWith(`${uid}_`)) {
                delete cache[key];
            }
        }
        cache[cacheKey] = liteJson;
        saveSettingsDebounced();
    }

    return liteJson;
}

// ============================================================================
// Lite Context Formatting
// ============================================================================

/**
 * Converts a Lite JSON object to the text format injected into the prompt.
 */
function formatLiteContext(liteJson) {
    const attrs = liteJson.quick_attributes || {};
    const lines = [];

    lines.push(`<Lite_Context: ${liteJson.entity_name}>`);
    lines.push(`Type: ${liteJson.entity_type}`);
    lines.push(`Core: ${liteJson.core_identity}`);

    // Format attributes
    const attrParts = [];
    if (attrs.personality?.length) attrParts.push(`[Personality: ${attrs.personality.join(', ')}]`);
    if (attrs.appearance?.length) attrParts.push(`[Appearance: ${attrs.appearance.join(', ')}]`);
    if (attrs.speech_style?.length) attrParts.push(`[Speech: ${attrs.speech_style.join(', ')}]`);

    // Include any extra attribute keys
    for (const [key, val] of Object.entries(attrs)) {
        if (!['personality', 'appearance', 'speech_style'].includes(key) && Array.isArray(val)) {
            attrParts.push(`[${key}: ${val.join(', ')}]`);
        }
    }

    if (attrParts.length) {
        lines.push(`Attributes: ${attrParts.join(' ')}`);
    }

    // Format deep pointers
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

/**
 * Gets all active World Info entries from the current context.
 * Returns entries from all active lorebooks (global + character).
 */
function getWorldInfoEntries() {
    const context = getContext();
    const entries = [];

    // Access world info from the chat's active data
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

/**
 * Resolves a pointer tag to the full content from the original lorebook entry.
 *
 * @param {string} pointerTag - The pointer tag (e.g., #Alice_History)
 * @returns {string|null} The full section content or null
 */
function resolvePointer(pointerTag) {
    const pointerInfo = activePointerMap[pointerTag];
    if (!pointerInfo) {
        console.warn(`[SmartRAG] Unknown pointer: ${pointerTag}`);
        return null;
    }

    // Get the full entry content
    const entries = getWorldInfoEntries();
    const entry = entries.find(e => e.uid === pointerInfo.entryUid);
    if (!entry) {
        console.warn(`[SmartRAG] Entry not found for pointer: ${pointerTag}`);
        return null;
    }

    return entry.content;
}

// ============================================================================
// Context Injection (Step 3: Lite Context into Prompt)
// ============================================================================

/**
 * Handles the GENERATION_STARTED event to inject Lite contexts and
 * the FETCH system instruction into the prompt.
 */
async function onGenerationStarted(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;

    // Reset pointer map for this generation
    activePointerMap = {};

    const entries = getWorldInfoEntries();
    const liteBlocks = [];

    for (const entry of entries) {
        const liteJson = await getOrGenerateLite(entry.uid, entry.content, entry.name);

        if (liteJson) {
            // Register pointers
            if (liteJson.deep_pointers) {
                for (const pointer of liteJson.deep_pointers) {
                    activePointerMap[pointer.pointer_tag] = {
                        entryUid: entry.uid,
                        sectionHint: pointer.hint,
                    };
                }
            }

            liteBlocks.push(formatLiteContext(liteJson));
        }
    }

    // Inject lite contexts
    if (liteBlocks.length > 0) {
        const liteContent = '<Available_Knowledge>\n' + liteBlocks.join('\n\n') + '\n</Available_Knowledge>';

        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_lite',
                liteContent,
                1,   // extension_prompt_types.IN_PROMPT
                0,   // position (top of extensions area)
            );
        }
    }

    // Inject FETCH system instruction
    if (settings.inject_system_prompt) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_system',
                MAIN_AI_SYSTEM_INJECTION,
                1,   // extension_prompt_types.IN_PROMPT
                0,
            );
        }
    }

    // If we're regenerating after a FETCH, inject the deep content
    if (pendingDeepFetchContent) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_deep',
                `<Deep_Lore_Response>\n${pendingDeepFetchContent}\n</Deep_Lore_Response>\nNow continue your response seamlessly using the deep lore above. Do not mention the fetch system.`,
                1,
                0,
            );
        }
        pendingDeepFetchContent = null;
        isRegenerating = false;
    }
}

// ============================================================================
// FETCH Interception (Step 4: Deep Fetch)
// ============================================================================

/**
 * Intercepts AI messages to detect [FETCH: #pointer] commands.
 * If found, suppresses the message, resolves the pointer, and triggers regeneration.
 */
async function onMessageReceived(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || isRegenerating) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return;

    const message = chat[messageIndex];
    if (!message || message.is_user) return;

    const text = message.mes || '';

    // Check for FETCH command
    const fetchMatch = text.match(/\[FETCH:\s*(#[\w_]+)\s*\]/);
    if (!fetchMatch) return;

    const pointerTag = fetchMatch[1];
    console.log(`[SmartRAG] Detected FETCH request for: ${pointerTag}`);

    // Resolve the pointer to full content
    const deepContent = resolvePointer(pointerTag);
    if (!deepContent) {
        console.warn(`[SmartRAG] Could not resolve pointer: ${pointerTag}`);
        toastr.warning(`Could not resolve pointer: ${pointerTag}`, 'Smart RAG');
        return;
    }

    // Set up the deep content for injection on regeneration
    pendingDeepFetchContent = `[Deep Lore for ${pointerTag}]\n${deepContent}`;
    isRegenerating = true;

    toastr.info(`Fetching deep lore: ${pointerTag}`, 'Smart RAG', { timeOut: 2000 });

    // Delete the message with [FETCH] from chat
    // Use ST's built-in method if available
    if (typeof context.deleteMessageByIndex === 'function') {
        await context.deleteMessageByIndex(messageIndex);
    } else {
        // Fallback: remove from chat array and DOM
        chat.splice(messageIndex, 1);
        $(`.mes[mesid="${messageIndex}"]`).remove();
    }

    // Trigger regeneration so the AI generates a proper response
    // with the deep content available
    if (typeof context.generate === 'function') {
        await context.generate('normal');
    } else {
        // Fallback: click the regenerate button
        $('#option_regenerate').trigger('click');
    }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Generates Lite versions for all active lorebook entries.
 */
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

/**
 * Clears all cached Lite entries.
 */
function clearLiteCache() {
    const settings = getSettings();
    settings.lite_cache = {};
    saveSettingsDebounced();
    activePointerMap = {};
    toastr.info('Lite cache cleared.', 'Smart RAG');
    $('#smart_rag_status').text('Cache cleared.').attr('class', 'smart-rag-status info');
}

// ============================================================================
// Chat Change Handler
// ============================================================================

/**
 * When a new chat is loaded, optionally pre-generate Lite versions.
 */
async function onChatChanged() {
    const settings = getSettings();
    if (!settings.enabled || !settings.auto_generate) return;

    // Small delay to let world info load
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
        console.log('[SmartRAG] Auto-generating Lite entries for new chat...');
        await generateAllLiteEntries();
    }
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async () => {
    // Load HTML settings panel
    const settingsHtml = await $.get(`${EXTENSION_FOLDER}/index.html`);
    $('#extensions_settings2').append(settingsHtml);

    // Load settings into UI
    loadSettings();

    // Bind UI events
    $('#smart_rag_enabled').on('change', saveSettings);
    $('#smart_rag_worker_endpoint').on('input', saveSettings);
    $('#smart_rag_worker_model').on('input', saveSettings);
    $('#smart_rag_worker_api_key').on('input', saveSettings);
    $('#smart_rag_min_content_length').on('input', saveSettings);
    $('#smart_rag_auto_generate').on('change', saveSettings);
    $('#smart_rag_inject_system_prompt').on('change', saveSettings);

    // Button handlers
    $('#smart_rag_generate_all').on('click', generateAllLiteEntries);
    $('#smart_rag_clear_cache').on('click', clearLiteCache);
    $('#smart_rag_test_worker').on('click', testWorkerConnection);

    // Register event hooks
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[SmartRAG] Smart RAG Lorebook extension loaded.');
});
