// ==UserScript==
// @name         批改网模拟打字输入
// @namespace    local.pigai.typing-simulator
// @version      2.1.4
// @description  用 OpenAI 兼容接口生成作文，并在批改网作文框中逐字输入。
// @match        https://www.pigai.org/*
// @match        https://pigai.org/*
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

    // 清理提取出的标题：优先取引号/书名号内的内容，再去掉尾随的说明文字和标点。
    function cleanTitle(value) {
        if (!value) return '';
        let text = String(value).replace(/\s+/g, ' ').trim();

        // 标题被引号或书名号包裹时只取其中的内容，
        // 这样 `Title: "My Campus Life". Write at least 120 words` 只会留下标题本身。
        const wrapped = /["\u201c\u2018]\s*([^"\u201d\u2019]{1,160}?)\s*["\u201d\u2019]/.exec(text)
            || /《\s*([^》]{1,160}?)\s*》/.exec(text);
        if (wrapped && wrapped[1] && wrapped[1].trim()) text = wrapped[1].trim();

        text = text
            .replace(/^[（(【\[]+/, '')
            .replace(/[）)】\]]+$/, '')
            .replace(/^["'\u201c\u201d\u2018\u2019《》]+/, '')
            .replace(/["'\u201c\u201d\u2018\u2019《》]+$/, '')
            .trim();

        // 只按真正的句末标点截断尾随说明，避免把 `（三）` 之类的标题内部标点也切掉。
        const cut = text.search(/(?:[.!?]\s+\S|[。！？]\s*\S)/);
        if (cut > 0) text = text.slice(0, cut);

        return text
            .replace(/[。！？.!?]+$/, '')
            .replace(/[，,；;：:、~～\-—]+$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 判断候选文本是否像一个标题：不能是元信息，也不能短到只是标点或单字。
    function looksLikeTitle(value) {
        const text = cleanTitle(value);
        if (text.length < 2) return false;
        if (text.length > 160) return false;
        // 明显是页面元信息或提示语的内容要排除。
        return !/(作文号|教师|字数|满分|截止时间|注意|请选择|请在下方|禁止粘贴|检测|用时|学号)/.test(text);
    }

    // 从中英文题目要求中提取标题。按"明确字段 -> 常见句式 -> 兜底"的顺序匹配，
    // 逐行尝试，越靠前的规则越不容易误判。
    function extractTitle(prompt) {
        if (!prompt) return '';
        const lines = String(prompt)
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        // 明确给出标题的字段：标题：xxx / Title: xxx / 要求 xxx
        const labelPatterns = [
            // 批改网的题干常带作业编号前缀，如 `写作2-Reflections on My Choice of Major`
            // 或 `题目：[3435109]25级...-写作2-Reflections on My Choice of Major`，
            // 标题就在 `写作N-` 之后，因此优先按这个结构精确提取。
            /(?:写作|作文|Unit|Lesson|Chapter)\s*\d+\s*[-–—.、:：]\s*(.+)$/i,
            /(?:作文题目|文章题目|题目|标题)\s*[:：]\s*\[?\d*\]?\s*(.+)/i,
            /^(?:写作)?要求\s*[:：]?\s*(.+)$/i,
            /(?:作文题目|文章题目|题目|标题)\s*[:：]\s*(.+)/i,
            /(?:essay\s+)?(?:topic|title)\s*[:：]\s*(.+)/i,
            // "Your title: A Memorable Trip."
            /your\s+(?:essay\s+)?title\s*(?:is|:)\s*(.+)/i,
            /the\s+title\s+of\s+your\s+essay\s+should\s+be\s+(.+)/i,
        ];

        // 常见句式：about "xxx" / entitled "xxx" / titled "xxx"
        const quotedPhrase = (keyword) => new RegExp(
            keyword + '\\s*[:：]?\\s*["\u201c\u2018\']([^"\u201d\u2019\']+)[\\s\\S]{0,40}?["\u201d\u2019\']',
            'i'
        );
        const phrasePatterns = [
            quotedPhrase('about'),
            quotedPhrase('entitled'),
            quotedPhrase('titled'),
            quotedPhrase('topic'),
            quotedPhrase('on\\s+the\\s+topic'),
        ];

        for (const line of lines) {
            for (const pattern of labelPatterns) {
                const match = line.match(pattern);
                if (match && looksLikeTitle(match[1])) return cleanTitle(match[1]);
            }
        }

        const plain = lines.join(' ');
        for (const pattern of phrasePatterns) {
            const match = plain.match(pattern);
            if (match && looksLikeTitle(match[1])) return cleanTitle(match[1]);
        }

        // 兜底一：书名号包裹的标题，如《我的家乡》
        const bracket = plain.match(/《([^》]{1,120})》/);
        if (bracket && looksLikeTitle(bracket[1])) return cleanTitle(bracket[1]);

        // 兜底二：整句里唯一的短引号片段，通常就是标题而不是说明文字。
        const quoted = plain.match(/["\u201c\u2018]([^"\u201d\u2019]{1,120})["\u201d\u2019]/);
        if (quoted && looksLikeTitle(quoted[1])) return cleanTitle(quoted[1]);

        // 兜底三：批改网的题干直接把标题写在要求段落里，形如
        // `写作2-Reflections on My Choice of Major`，没有引号也没有字段名。
        // 去掉开头的作业编号前缀后，整行就是标题。
        for (const line of lines) {
            if (/(作文号|教师|字数|满分|注意|截止时间|当前时间|用时)/.test(line)) continue;
            const stripped = line.replace(/^(?:写作|作文|Unit|Lesson|Chapter)\s*\d+\s*[-–—.、:：]\s*/i, '').trim();
            if (stripped !== line && looksLikeTitle(stripped)) return cleanTitle(stripped);
        }

        return '';
    }

    // 定位页面标题输入框。页面改版时 #title 可能不在，做一次保守的兜底查找。
    function findTitleInput() {
        const direct = document.querySelector('input#title');
        if (direct) return direct;
        const form = document.querySelector('#request_y')?.closest('form') || document;
        return form.querySelector('input[name="title"], input#essay_title, input.title');
    }

    // 将解析出的标题写入批改网标题框，并触发页面表单监听。
    // 不改动焦点：填标题发生在打字开始前，抢焦点会打断后续的作文输入。
    function fillPageTitle(title) {
        const target = findTitleInput();
        if (!target || !title || target.disabled || target.readOnly) return false;
        setNativeValue(target, title);
        try {
            target.setSelectionRange(title.length, title.length);
        } catch (_) {
            // 忽略不支持设置选区的场景。
        }
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
            if (!requirement.title) {
                // 提示而不是静默失败，便于判断是"题目里没有标题"还是"选择器不对"。
                setStatus('已识别题目，但未从题干中提取到标题；如需填写请在页面手动输入', 'paused');
                return '';
            }
            if (fillPageTitle(requirement.title)) return requirement.title;
            setStatus(`已提取到标题“${requirement.title}”，但未找到页面标题输入框 #title`, 'error');
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

    // 通过原型上的原生 value setter 改值，让 React/Vue 等框架能感知到这次修改。
    function setNativeValue(element, value) {
        const prototype = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && typeof descriptor.set === 'function') {
            descriptor.set.call(element, value);
            return;
        }
        element.value = value;
    }

    // 不依赖焦点地插入文本：焦点在框内时沿用光标位置，否则把内容追加到结尾。
    // 插入区间在改值之前算好，避免非聚焦状态下 selection 为 0 导致文字被插到开头或丢失。
    function insertTextIntoSource(source, text) {
        if (!source || text === undefined || text === null) return;
        const next = String(text);
        if (!next) return;
        if (source.disabled || source.readOnly) return;

        const value = String(source.value ?? '');
        let start;
        let end;
        if (source === document.activeElement) {
            start = Number.isInteger(source.selectionStart) ? source.selectionStart : value.length;
            end = Number.isInteger(source.selectionEnd) ? source.selectionEnd : start;
        } else {
            start = value.length;
            end = value.length;
        }
        start = Math.max(0, Math.min(start, value.length));
        end = Math.max(start, Math.min(end, value.length));

        const caret = start + next.length;
        setNativeValue(source, value.slice(0, start) + next + value.slice(end));
        try {
            source.setSelectionRange(caret, caret);
        } catch (_) {
            // 个别 input 类型不支持设置选区，忽略即可。
        }

        // inputType 区分覆盖选区与追加，便于页面上的字数统计等监听器正确处理。
        let event;
        try {
            event = new InputEvent('input', {
                inputType: 'insertText',
                data: next,
                bubbles: true,
                composed: true,
            });
        } catch (_) {
            event = new Event('input', { bubbles: true });
        }
        source.dispatchEvent(event);
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

    // 逐字符写入。合成键盘事件（isTrusted 恒为 false）对页面没有实际作用，
    // 这里只负责改值并派发 input 事件，因此不再要求目标元素处于聚焦状态。
    function typeCharInto(target, char) {
        insertTextIntoSource(target, char);
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

    // 后台安全的定时等待。
    // 页面切到后台后 setTimeout 会被浏览器节流（先降到 >=1s，长时间隐藏后约 1 次/分钟），
    // 纯定时器驱动会让打字实际停住。这里分两条路径：
    //   前台：原生 setTimeout，延时精确，不产生任何额外流量。
    //   后台：由 requestAnimationFrame 限速驱动 + MessageChannel 自查，
    //         两者都不依赖 setTimeout，因此不会被"冻结"到停住。
    const sleep = (() => {
        if (typeof MessageChannel !== 'function') {
            // 极端兜底：没有 MessageChannel 时只能依赖 setTimeout，此时后台仍会被节流。
            return (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        }
        const channel = new MessageChannel();
        // 打字循环是串行的，同一时刻只有一个等待者。
        let waiter = null;
        let beatScheduled = false;

        // 后台心跳的节拍器。rAF 在后台本就低频，天然限制了自查次数；
        // 没有 rAF 时退回 setTimeout（可能被节流，但不影响正确性）。
        const scheduleBeat = typeof requestAnimationFrame === 'function'
            ? (callback) => requestAnimationFrame(callback)
            : (callback) => setTimeout(callback, 60);

        function requestBeat() {
            if (beatScheduled || !waiter || waiter.settled) return;
            beatScheduled = true;
            scheduleBeat(() => {
                beatScheduled = false;
                if (!waiter || waiter.settled) return;
                channel.port2.postMessage(null);
            });
        }

        // 收到自查消息时只做一次判断，绝不在这里连续续期，避免空转。
        channel.port1.onmessage = () => {
            if (!waiter || waiter.settled) {
                waiter = null;
                return;
            }
            if (Date.now() - waiter.startedAt >= waiter.span) {
                waiter.finish();
                return;
            }
            requestBeat();
        };

        return function sleep(milliseconds) {
            const span = Math.max(0, Number(milliseconds) || 0);
            if (span === 0) return Promise.resolve();
            return new Promise((resolve) => {
                const entry = {
                    span,
                    startedAt: Date.now(),
                    settled: false,
                    finishTimer: null,
                };
                entry.finish = () => {
                    if (entry.settled) return;
                    entry.settled = true;
                    if (entry.finishTimer !== null) clearTimeout(entry.finishTimer);
                    if (waiter === entry) waiter = null;
                    resolve();
                };
                waiter = entry;
                // 计时器在任何情况下都保留：前台它就是精确计时，
                // 后台它可能被推迟，此时由心跳负责把等待推进。
                entry.finishTimer = setTimeout(entry.finish, span);
                if (document.hidden === true) {
                    channel.port2.postMessage(null);
                }
            });
        };
    })();

    // 按真实经过时间计时，避免后台节流导致等待被拉长后节奏失控。
    async function waitWithControls(milliseconds, runId) {
        const deadline = Date.now() + milliseconds;
        while (true) {
            if (state.stopRequested || state.runId !== runId) return false;
            if (state.paused) {
                // 暂停期间也要保持可响应，且不能依赖被节流的定时器。
                await sleep(60);
                continue;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await sleep(Math.min(60, remaining));
        }
        return !state.stopRequested && state.runId === runId;
    }

    // 逐字符执行输入，并在异常、停止或文本框被替换时安全收尾。
    // stealFocus 为 false 时全程不抢焦点，打字过程中仍可正常操作面板和其他区域。
    async function typeText(text, speed, clearExisting, stealFocus) {
        const target = findTarget();
        if (!target) throw new Error('未找到作文文本框 #contents');
        if (target.disabled || target.readOnly) throw new Error('作文文本框当前不可编辑');

        const runId = ++state.runId;
        state.running = true;
        state.paused = false;
        state.stopRequested = false;
        state.target = target;
        state.typed = 0;

        if (stealFocus) target.focus();

        if (clearExisting) {
            setNativeValue(target, '');
            try {
                target.setSelectionRange(0, 0);
            } catch (_) {
                // 忽略不支持设置选区的场景。
            }
            target.dispatchEvent(new Event('input', { bubbles: true }));
        }

        try {
            for (let index = 0; index < text.length; index += 1) {
                if (state.stopRequested || state.runId !== runId) break;
                while (state.paused) {
                    setStatus(`已暂停：${state.typed}/${text.length} 字符`, 'paused');
                    await sleep(80);
                    if (state.stopRequested || state.runId !== runId) break;
                }
                if (state.stopRequested || state.runId !== runId) break;

                const currentTarget = findTarget();
                if (currentTarget !== target) throw new Error('作文文本框已被页面重新加载');
                typeCharInto(target, text[index]);
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
                <label><input id="pigai-typing-focus" type="checkbox"> 打字时抢占焦点（默认关闭，可边打字边操作页面）</label>
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
            const titleFilled = fillTitleFromPage();
            if (titleFilled) setStatus(`标题已填入：“${titleFilled}”，正在准备输入...`, 'done');
            try {
                typeText(
                    source,
                    Math.min(1200, speed),
                    $('#pigai-typing-clear').checked,
                    $('#pigai-typing-focus').checked
                )
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
