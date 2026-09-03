// ==UserScript==
// @name         批改网模拟打字输入
// @namespace    local.pigai.typing-simulator
// @version      2.1.0
// @description  用 OpenAI 兼容接口生成作文，并在批改网作文框中逐字输入。
// @match        https://www.pigai.org/index.php*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const PANEL_ID = 'pigai-typing-simulator-panel';
    const STYLE_ID = 'pigai-typing-simulator-style';
    const SETTINGS_KEY = 'pigai-typing-simulator-settings-v2';
    const DEFAULT_SETTINGS = {
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'deepseek-ai/DeepSeek-V4-Flash',
        apiKey: '',
    };
    const state = {
        running: false,
        generating: false,
        paused: false,
        stopRequested: false,
        runId: 0,
        target: null,
        typed: 0,
    };

    const $ = (selector, root = document) => root.querySelector(selector);

    // 读取本地配置；API Key 仅保存在当前浏览器的 localStorage 中。
    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return { ...DEFAULT_SETTINGS, ...saved };
        } catch (_) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    // 保存接口配置，切换题目或刷新页面后仍可复用。
    function saveSettings(settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    // 读取页面中的作文要求，并优先采用英文题目中明确的词数范围。
    function readEssayRequirement() {
        const requestNode = document.querySelector('#request_y');
        const prompt = requestNode ? (requestNode.innerText || requestNode.textContent || '').trim() : '';
        if (!prompt) throw new Error('未找到题目要求 #request_y');

        const explicitRange = prompt.match(/at least\s+(\d+)\s+words?[\s\S]{0,160}?no more than\s+(\d+)\s+words?/i);
        const pageText = document.body ? document.body.innerText : '';
        const pageRange = pageText.match(/字数\s*[:：]\s*(\d+)\s*[~～-]\s*(\d+)/);
        const minWords = explicitRange ? Number(explicitRange[1]) : pageRange ? Number(pageRange[1]) : 120;
        const maxWords = explicitRange ? Number(explicitRange[2]) : pageRange ? Number(pageRange[2]) : 180;
        return {
            prompt,
            title: extractTitle(prompt),
            minWords: Math.min(minWords, maxWords),
            maxWords: Math.max(minWords, maxWords),
        };
    }

    // 从中英文题目要求中提取标题，优先匹配明确的 Title/题目/标题字段。
    function extractTitle(prompt) {
        const patterns = [
            /(?:essay\s+)?(?:topic|title)\s*[:：]?\s*["““']([^"””']+)["””']/i,
            /(?:作文题目|题目|标题)\s*[:：]\s*["““']?([^"””'\r\n]+)["””']?/i,
            /topic\s+["““']([^"””']+)["””']/i,
        ];
        for (const pattern of patterns) {
            const match = prompt.match(pattern);
            if (match && match[1]) return match[1].trim().replace(/[。.!！?？]+$/, '');
        }
        return '';
    }

    // 将解析出的标题写入批改网标题框，并触发页面表单监听。
    function fillPageTitle(title) {
        const target = document.querySelector('input#title');
        if (!target || !title || target.disabled || target.readOnly) return false;
        target.focus();
        target.setRangeText(title, 0, target.value.length, 'end');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // 按面板开关决定是否从当前题目要求自动填充页面标题。
    function fillTitleFromPage() {
        const autoTitle = document.querySelector('#pigai-auto-title');
        if (autoTitle && !autoTitle.checked) return '';
        try {
            const requirement = readEssayRequirement();
            if (requirement.title && fillPageTitle(requirement.title)) return requirement.title;
        } catch (_) {
            // 页面暂未渲染题目时保留原标题，不阻断作文输入。
        }
        return '';
    }

    // 将不同 OpenAI 兼容服务商的 Base URL 规范化为 chat completions 地址。
    function buildChatEndpoint(baseUrl) {
        const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!normalized) throw new Error('请填写 API Base URL');
        return /\/chat\/completions$/i.test(normalized)
            ? normalized
            : `${normalized}/chat/completions`;
    }

    // 用 GM_xmlhttpRequest 规避跨域限制，并保留 fetch 作为普通浏览器回退路径。
    function requestJson(url, apiKey, body) {
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        };
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers,
                    data: JSON.stringify(body),
                    timeout: 90000,
                    onload: (response) => {
                        let payload;
                        try {
                            payload = JSON.parse(response.responseText || '{}');
                        } catch (_) {
                            reject(new Error(`接口返回不是 JSON（HTTP ${response.status}）`));
                            return;
                        }
                        if (response.status < 200 || response.status >= 300) {
                            reject(new Error(payload.error?.message || `接口请求失败（HTTP ${response.status}）`));
                            return;
                        }
                        resolve(payload);
                    },
                    onerror: () => reject(new Error('接口网络请求失败')),
                    ontimeout: () => reject(new Error('接口请求超时')),
                });
            });
        }

        return fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        }).then(async (response) => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error?.message || `接口请求失败（HTTP ${response.status}）`);
            return payload;
        });
    }

    // 兼容字符串和多模态数组格式，并清理模型可能返回的 Markdown 代码围栏。
    function extractEssay(payload) {
        const content = payload?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
            ? content.map((item) => typeof item === 'string' ? item : item?.text || '').join('')
            : typeof content === 'string' ? content : '';
        const cleaned = text.replace(/^\s*```(?:text|英文|英语)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        if (!cleaned) throw new Error('接口没有返回作文正文');
        return cleaned;
    }

    // 用生成结果替换插件文本框内容，并触发输入事件让面板状态同步。
    function replaceSourceText(text) {
        const source = document.querySelector('#pigai-typing-source');
        if (!source) throw new Error('未找到插件作文输入框');
        source.focus();
        source.setRangeText(text, 0, source.value.length, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        return source;
    }

    // 调用 OpenAI 兼容接口生成作文，生成后直接填入插件文本框。
    async function generateEssay() {
        if (state.running) throw new Error('请先停止当前打字任务');
        const settings = {
            baseUrl: $('#pigai-ai-base-url')?.value.trim() || DEFAULT_SETTINGS.baseUrl,
            model: $('#pigai-ai-model')?.value.trim() || DEFAULT_SETTINGS.model,
            apiKey: $('#pigai-ai-key')?.value.trim() || '',
        };
        if (!settings.apiKey) throw new Error('请先填写 API Key');
        if (!settings.model) throw new Error('请填写模型名称');

        const requirement = readEssayRequirement();
        saveSettings(settings);
        state.generating = true;
        refreshButtons();
        setStatus('正在读取题目并生成作文...', 'running');

        try {
            const userPrompt = [
                '请根据以下英文作文题目写一篇自然、连贯的英文短文。',
                `严格控制在 ${requirement.minWords}-${requirement.maxWords} 个英文单词。`,
                '只输出作文正文，不要标题、解释、项目符号、Markdown 或字数说明。',
                '',
                requirement.prompt,
            ].join('\n');
            const payload = await requestJson(buildChatEndpoint(settings.baseUrl), settings.apiKey, {
                model: settings.model,
                messages: [
                    { role: 'system', content: 'You are an English writing assistant. Follow the requested word count exactly and output only the essay.' },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.75,
                max_tokens: Math.max(512, requirement.maxWords * 4),
                stream: false,
            });
            const essay = extractEssay(payload);
            replaceSourceText(essay);
            const autoTitleEnabled = document.querySelector('#pigai-auto-title')?.checked !== false;
            const titleFilled = autoTitleEnabled && requirement.title && fillPageTitle(requirement.title);
            const words = (essay.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || []).length;
            setStatus(`AI 已生成并填入：${words} 个英文单词${titleFilled ? `；标题已设置为“${requirement.title}”` : ''}`, 'done');
        } finally {
            state.generating = false;
            refreshButtons();
        }
    }

    // 等待批改网动态渲染作文文本框，并在页面切换后刷新引用。
    function findTarget() {
        const target = document.querySelector('textarea#contents');
        state.target = target || null;
        return state.target;
    }

    // 统一更新面板状态，避免输入过程中频繁重建 DOM。
    function setStatus(message, kind = '') {
        const status = document.querySelector('#pigai-typing-status');
        if (!status) return;
        status.textContent = message;
        status.dataset.kind = kind;
    }

    function insertTextIntoSource(source, text) {
        if (!source || !text) return;
        const start = Number.isInteger(source.selectionStart) ? source.selectionStart : source.value.length;
        const end = Number.isInteger(source.selectionEnd) ? source.selectionEnd : start;
        source.setRangeText(text, start, end, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 在插件输入框内自行处理粘贴，阻断批改网页对 paste 事件的拦截。
    function pasteIntoSource(event) {
        const source = event.currentTarget;
        const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (!text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        insertTextIntoSource(source, text);
    }

    // 在 window 捕获阶段处理面板内所有输入框，优先于网站常见的 document/冒泡阶段 paste 拦截。
    function interceptPanelPaste(event) {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(`#${PANEL_ID}`)) return;
        if (!target.matches('textarea, input[type="text"], input[type="password"], input:not([type])')) return;
        const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (!text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        insertTextIntoSource(target, text);
    }

    // 通过浏览器剪贴板 API 读取文本，作为 paste 事件被页面吞掉时的备用入口。
    async function readClipboardIntoSource() {
        const source = document.querySelector('#pigai-typing-source');
        if (!source || !navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            throw new Error('当前浏览器不支持读取剪贴板，请使用 Ctrl+V');
        }
        const text = await navigator.clipboard.readText();
        if (!text) throw new Error('剪贴板中没有文本');
        source.focus();
        source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        setStatus(`已从剪贴板读取 ${text.length} 字符`, 'done');
    }

    // 发送键盘和输入事件；isTrusted 由浏览器控制，脚本只负责完整触发监听链。
    function dispatchTypingEvents(target, char) {
        const key = char === '\n' ? 'Enter' : char === ' ' ? ' ' : char;
        const code = char === '\n' ? 'Enter' : char === ' ' ? 'Space' : '';
        const keyboardInit = {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true,
        };

        target.dispatchEvent(new KeyboardEvent('keydown', keyboardInit));

        let beforeInput;
        try {
            beforeInput = new InputEvent('beforeinput', {
                inputType: 'insertText',
                data: char,
                bubbles: true,
                cancelable: true,
                composed: true,
            });
        } catch (_) {
            beforeInput = new Event('beforeinput', {
                bubbles: true,
                cancelable: true,
            });
        }
        target.dispatchEvent(beforeInput);

        target.dispatchEvent(new KeyboardEvent('keypress', keyboardInit));

        // 使用 setRangeText 保留光标位置，比直接拼接 value 更接近实际输入行为。
        const start = Number.isInteger(target.selectionStart)
            ? target.selectionStart
            : target.value.length;
        const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
        target.setRangeText(char, start, end, 'end');

        let inputEvent;
        try {
            inputEvent = new InputEvent('input', {
                inputType: 'insertText',
                data: char,
                bubbles: true,
                composed: true,
            });
        } catch (_) {
            inputEvent = new Event('input', { bubbles: true });
        }
        target.dispatchEvent(inputEvent);
        target.dispatchEvent(new KeyboardEvent('keyup', keyboardInit));
    }

    // 生成小幅波动的间隔；基础速度稳定，标点后增加短暂停顿。
    function nextDelay(char, speed) {
        const base = 60000 / Math.max(1, speed);
        const speedFactor = 0.90 + Math.random() * 0.20;
        let extra = 0;
        if (/[.!?。！？]/.test(char)) extra = 260 + Math.random() * 320;
        else if (/[，,；;：:]/.test(char)) extra = 90 + Math.random() * 160;
        else if (/\s/.test(char)) extra = 45 + Math.random() * 90;
        return Math.max(18, base * speedFactor + extra);
    }

    // 将等待拆成小片段，使暂停和停止按钮能在当前延时内及时生效。
    async function waitWithControls(milliseconds, runId) {
        let remaining = milliseconds;
        while (remaining > 0) {
            if (state.stopRequested || state.runId !== runId) return false;
            while (state.paused) {
                if (state.stopRequested || state.runId !== runId) return false;
                await new Promise((resolve) => setTimeout(resolve, 60));
            }
            const slice = Math.min(60, remaining);
            await new Promise((resolve) => setTimeout(resolve, slice));
            remaining -= slice;
        }
        return !state.stopRequested && state.runId === runId;
    }

    // 逐字符执行输入，并在异常、停止或文本框被替换时安全收尾。
    async function typeText(text, speed, clearExisting) {
        const target = findTarget();
        if (!target) throw new Error('未找到作文文本框 #contents');
        if (target.disabled || target.readOnly) throw new Error('作文文本框当前不可编辑');

        const runId = ++state.runId;
        state.running = true;
        state.paused = false;
        state.stopRequested = false;
        state.target = target;
        state.typed = 0;

        if (clearExisting) {
            target.focus();
            target.setRangeText('', 0, target.value.length, 'end');
            target.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            target.focus();
        }

        try {
            for (let index = 0; index < text.length; index += 1) {
                if (state.stopRequested || state.runId !== runId) break;
                while (state.paused) {
                    setStatus(`已暂停：${state.typed}/${text.length} 字符`, 'paused');
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    if (state.stopRequested || state.runId !== runId) break;
                }
                if (state.stopRequested || state.runId !== runId) break;

                const currentTarget = findTarget();
                if (currentTarget !== target) throw new Error('作文文本框已被页面重新加载');
                dispatchTypingEvents(target, text[index]);
                state.typed = index + 1;
                setStatus(`输入中：${state.typed}/${text.length} 字符`, 'running');

                if (!(await waitWithControls(nextDelay(text[index], speed), runId))) break;
            }

            if (!state.stopRequested && state.runId === runId && state.typed === text.length) {
                target.dispatchEvent(new Event('change', { bubbles: true }));
                setStatus(`完成：已输入 ${state.typed} 字符`, 'done');
            } else if (state.stopRequested) {
                setStatus(`已停止：${state.typed}/${text.length} 字符`, 'stopped');
            }
        } finally {
            if (state.runId === runId) {
                state.running = false;
                state.paused = false;
            }
            refreshButtons();
        }
    }

    // 根据运行状态启用或禁用控制按钮，防止重复启动造成多个输入循环。
    function refreshButtons() {
        const start = document.querySelector('#pigai-typing-start');
        const pause = document.querySelector('#pigai-typing-pause');
        const stop = document.querySelector('#pigai-typing-stop');
        if (!start || !pause || !stop) return;
        const generating = state.generating;
        start.disabled = state.running || generating;
        pause.disabled = !state.running;
        stop.disabled = !state.running;
        pause.textContent = state.paused ? '继续' : '暂停';
        const generate = document.querySelector('#pigai-ai-generate');
        if (generate) generate.disabled = state.running || generating;
    }

    // 将配置值安全写入面板 HTML 属性，避免引号或尖括号破坏界面结构。
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 创建悬浮面板和样式，所有控件都使用固定 ID 以避免污染页面表单。
    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} {
                position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
                width: 390px; padding: 14px; color: #1f2937; background: #fff;
                border: 1px solid #d1d5db; border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, .16);
                font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #${PANEL_ID} * { box-sizing: border-box; }
            #${PANEL_ID} .pigai-title { margin-bottom: 9px; font-weight: 700; }
            #${PANEL_ID} textarea { display: block; width: 100%; min-height: 120px; resize: vertical;
                padding: 8px; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
            #${PANEL_ID} .pigai-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
            #${PANEL_ID} input[type=number] { width: 76px; padding: 5px; border: 1px solid #cbd5e1; border-radius: 4px; }
            #${PANEL_ID} input[type=text], #${PANEL_ID} input[type=password] { min-width: 0; flex: 1;
                padding: 5px; border: 1px solid #cbd5e1; border-radius: 4px; font: inherit; }
            #${PANEL_ID} .pigai-config { display: grid; gap: 7px; margin: 10px 0; padding: 9px;
                border: 1px solid #e5e7eb; border-radius: 5px; background: #f8fafc; }
            #${PANEL_ID} .pigai-config label { display: flex; align-items: center; gap: 7px; }
            #${PANEL_ID} label { display: flex; align-items: center; gap: 5px; }
            #${PANEL_ID} .pigai-actions { display: flex; gap: 7px; margin-top: 11px; }
            #${PANEL_ID} button { flex: 1; padding: 6px 8px; border: 1px solid #9ca3af; border-radius: 5px;
                color: #111827; background: #f9fafb; cursor: pointer; font: inherit; }
            #${PANEL_ID} button:hover:not(:disabled) { background: #eef2ff; }
            #${PANEL_ID} button:disabled { cursor: not-allowed; opacity: .5; }
            #${PANEL_ID} #pigai-typing-status { min-height: 20px; margin-top: 8px; color: #4b5563; }
            #${PANEL_ID} #pigai-typing-status[data-kind=running] { color: #2563eb; }
            #${PANEL_ID} #pigai-typing-status[data-kind=done] { color: #15803d; }
            #${PANEL_ID} #pigai-typing-status[data-kind=stopped] { color: #b45309; }
            #${PANEL_ID} #pigai-typing-status[data-kind=error] { color: #b91c1c; }
        `;
        document.head.appendChild(style);

        const settings = loadSettings();
        const panel = document.createElement('section');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="pigai-title">批改网模拟打字</div>
            <textarea id="pigai-typing-source" placeholder="把作文文本放在这里"></textarea>
            <div class="pigai-config">
                <label>API Base URL <input id="pigai-ai-base-url" type="text" value="${escapeHtml(settings.baseUrl)}"></label>
                <label>模型 <input id="pigai-ai-model" type="text" value="${escapeHtml(settings.model)}"></label>
                <label>API Key <input id="pigai-ai-key" type="password" value="${escapeHtml(settings.apiKey)}" autocomplete="off"></label>
            </div>
            <div class="pigai-row">
                <label>速度 <input id="pigai-typing-speed" type="number" min="30" max="1200" step="10" value="280"> 字符/分钟</label>
            </div>
            <div class="pigai-row">
                <label><input id="pigai-typing-clear" type="checkbox" checked> 开始前清空文本框</label>
            </div>
            <div class="pigai-row">
                <label><input id="pigai-auto-title" type="checkbox" checked> 自动填写页面标题</label>
            </div>
            <div class="pigai-actions">
                <button id="pigai-ai-generate" type="button">AI生成作文</button>
                <button id="pigai-typing-clipboard" type="button">读取剪贴板</button>
            </div>
            <div class="pigai-actions">
                <button id="pigai-typing-start" type="button">开始</button>
                <button id="pigai-typing-pause" type="button" disabled>暂停</button>
                <button id="pigai-typing-stop" type="button" disabled>停止</button>
            </div>
            <div id="pigai-typing-status">正在查找 #contents...</div>
        `;
        document.body.appendChild(panel);

        const source = $('#pigai-typing-source');
        // 使用捕获阶段并立即停止传播，确保网站 document/window 监听器收不到该粘贴事件。
        source.addEventListener('paste', pasteIntoSource, true);

        $('#pigai-typing-clipboard').addEventListener('click', () => {
            readClipboardIntoSource().catch((error) => setStatus(error.message || '读取剪贴板失败', 'error'));
        });

        $('#pigai-ai-generate').addEventListener('click', () => {
            generateEssay().catch((error) => {
                state.generating = false;
                refreshButtons();
                setStatus(error.message || 'AI 生成失败', 'error');
            });
        });

        $('#pigai-typing-start').addEventListener('click', () => {
            const source = $('#pigai-typing-source').value;
            const speed = Number($('#pigai-typing-speed').value);
            if (!source) {
                setStatus('请先填写作文内容', 'error');
                return;
            }
            if (!Number.isFinite(speed) || speed < 30) {
                setStatus('速度需为不小于 30 的数字', 'error');
                return;
            }
            fillTitleFromPage();
            try {
                typeText(source, Math.min(1200, speed), $('#pigai-typing-clear').checked)
                    .catch((error) => {
                        state.running = false;
                        refreshButtons();
                        setStatus(error.message || '输入失败', 'error');
                    });
                refreshButtons();
            } catch (error) {
                setStatus(error.message || '输入失败', 'error');
            }
        });

        $('#pigai-typing-pause').addEventListener('click', () => {
            if (!state.running) return;
            state.paused = !state.paused;
            setStatus(state.paused ? `已暂停：${state.typed} 字符` : `继续输入：${state.typed} 字符`, state.paused ? 'paused' : 'running');
            refreshButtons();
        });

        $('#pigai-typing-stop').addEventListener('click', () => {
            if (!state.running) return;
            state.stopRequested = true;
            state.runId += 1;
            state.running = false;
            state.paused = false;
            setStatus(`已停止：${state.typed} 字符`, 'stopped');
            refreshButtons();
        });

        refreshButtons();
    }

    createPanel();
    window.addEventListener('paste', interceptPanelPaste, true);
    findTarget();
    setStatus(state.target ? '已找到作文文本框，可以开始' : '未找到 #contents，页面加载后会自动重试');

    // 处理批改网切换题目或异步重绘 textarea 的情况。
    const observer = new MutationObserver(() => {
        const previous = state.target;
        const current = findTarget();
        if (!state.running && current && current !== previous) {
            setStatus('已找到新的作文文本框，可以开始');
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
