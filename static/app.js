/* 灵犀文件管家 - 前端交互逻辑 */

// 文件分类定义（与后端保持一致）
const FILE_CATEGORIES = {
    'completion': {name: '完成图', folder: '_完成图', icon: '🎨', desc: '效果图、最终版展示图'},
    'source': {name: '工程文件', folder: '_工程文件', icon: '📐', desc: 'PSD/Spine 等可编辑源文件'},
    'spine_export': {name: '动画导出', folder: '_动画导出', icon: '📦', desc: 'Spine 导出的 skeleton 三件套'},
    'cutout': {name: '切图素材', folder: '_切图素材', icon: '✂️', desc: '给 Spine/程序用的切好的散图'},
    'icon_set': {name: '收集栏图标', folder: '_收集栏图标', icon: '🏅', desc: 'icon_001~xxx 系列'},
    'process_ai': {name: '过程-AI生图', folder: '_过程文件/AI生图', icon: '🤖', desc: '即梦/MJ/SD 生成图'},
    'process_ref': {name: '过程-参考截图', folder: '_过程文件/参考截图', icon: '📸', desc: '企微截图/屏幕截图'},
    'process_draft': {name: '过程-草稿迭代', folder: '_过程文件/草稿迭代', icon: '📝', desc: 'UUID文件名/带版本号的迭代稿'},
    'package': {name: '打包交付', folder: '_打包交付', icon: '📮', desc: '给程序的压缩包'},
    'unknown': {name: '未分类', folder: null, icon: '❓', desc: '无法识别的文件'}
};

class LingXiFileManager {
    constructor() {
        this.currentPath = '';
        this.historyStack = [];
        this.historyIndex = -1;
        this.selectedFiles = new Set();
        this.lastSelectedPath = null; // 用于 Shift 范围选择锚点
        this.viewMode = 'grid'; // grid | list | detail
        this.sortBy = 'name';
        this.sortDesc = false;
        this.roots = [];
        this.drives = [];
        this.currentItems = [];
        this.tags = [];
        this.socket = null;
        this.aiTaskId = null;
        this.aiResults = [];
        this.clipboard = null; // {mode:'copy'|'cut', paths:[]}
        this.currentSection = null; // 'recent' | 'favorites' | 'tags' | null
        this.browserState = null; // 目录选择器状态
        this.config = {};
        this.currentPreviewPath = null;

        this.init();
    }

    async init() {
        try {
            await this.loadConfig();
            this.initSocket();
            this.bindEvents();
            await this.loadRoots();
            await this.loadTags();
            this.updateUI();
        } catch (err) {
            console.error('初始化失败:', err);
            // 即使初始化失败，也要确保UI可以基本工作
            this.bindEvents();
            this.updateUI();
        }
    }

    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            this.config = await res.json();
            this.roots = this.config.roots || [];
        } catch (err) {
            console.error('加载配置失败:', err);
            this.config = { ai: {}, roots: [] };
        }
    }

    initSocket() {
        if (typeof io === 'undefined') {
            console.warn('socket.io 未加载，AI 批量功能将不可用');
            return;
        }
        this.socket = io();

        this.socket.on('connect', () => {
            this.setStatus('已连接');
        });
        this.socket.on('disconnect', () => {
            this.setStatus('连接断开');
        });
        this.socket.on('ai_progress', (data) => {
            this.updateAIProgress(data);
        });
        this.socket.on('ai_result_item', (data) => {
            this.addAIResultItem(data);
        });
    }

    bindEvents() {
        // 键盘快捷键（会自动排除输入框场景）
        document.addEventListener('keydown', (e) => this.handleKeydown(e));

        // 文件视图区事件（工作台-only 模式下可能不存在）
        const viewport = document.getElementById('fileViewport');
        if (viewport) {
            viewport.addEventListener('contextmenu', (e) => this.showContextMenu(e));
            viewport.addEventListener('click', (e) => {
                // 点击空白处清空选择
                if (e.target === viewport || e.target.id === 'fileGrid') {
                    this.selectedFiles.clear();
                    this.updateSelection();
                }
                this.hideContextMenu();
            });
        }

        // 搜索框（工作台-only 模式下可能不存在）
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            let searchTimer = null;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => this.handleSearch(e), 250);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.clearSearch();
            });
        }

        // 全局点击关闭右键菜单
        document.addEventListener('click', (e) => {
            const cm = document.getElementById('contextMenu');
            if (cm && !cm.contains(e.target)) this.hideContextMenu();
        });

        // 点击模态遮罩层关闭（仅当点到遮罩本身）
        document.querySelectorAll('.modal-overlay').forEach(ov => {
            ov.addEventListener('click', (e) => {
                if (e.target === ov) ov.classList.add('hidden');
            });
        });

        // 重命名输入框回车确认
        const renameInput = document.getElementById('renameInput');
        if (renameInput) {
            renameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmRename();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeRenameModal();
                }
            });
        }
    }

    /** 判断事件是否来自输入框/可编辑元素 */
    _isEditingTarget(e) {
        const t = e.target;
        if (!t) return false;
        const tag = (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (t.isContentEditable) return true;
        return false;
    }

    handleKeydown(e) {
        // 如果是在输入框/可编辑元素里，不要触发全局快捷键
        if (this._isEditingTarget(e)) return;

        // 如果有打开的模态框，也不拦截
        const hasOpenModal = Array.from(document.querySelectorAll('.modal-overlay'))
            .some(m => !m.classList.contains('hidden'));
        if (hasOpenModal && e.key !== 'Escape') return;

        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'k': {
                    const si = document.getElementById('searchInput');
                    if (si) { e.preventDefault(); si.focus(); }
                    break;
                }
                case 'a':
                    e.preventDefault();
                    this.selectAll();
                    break;
                case 'z':
                    e.preventDefault();
                    this.undoLast();
                    break;
                case 'c':
                    if (this.selectedFiles.size > 0) {
                        e.preventDefault();
                        this.copySelected();
                    }
                    break;
                case 'x':
                    if (this.selectedFiles.size > 0) {
                        e.preventDefault();
                        this.cutSelected();
                    }
                    break;
                case 'v':
                    if (this.clipboard) {
                        e.preventDefault();
                        this.pasteClipboard();
                    }
                    break;
            }
        } else {
            switch (e.key) {
                case 'F2':
                    e.preventDefault();
                    this.renameSelected();
                    break;
                case 'Delete':
                    e.preventDefault();
                    this.deleteSelected();
                    break;
                case 'Backspace':
                    e.preventDefault();
                    this.goUp();
                    break;
                case 'Enter':
                    e.preventDefault();
                    this.openSelected();
                    break;
                case 'Escape':
                    // 关闭任何打开的模态
                    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
                    this.hideContextMenu();
                    break;
            }
        }
    }

    async loadRoots() {
        // 工作台-only 模式：不再加载驱动器/根目录，也不自动导航到文件浏览
        try {
            const res = await fetch('/api/drives');
            const data = await res.json();
            this.drives = data.drives || [];
            this.roots = data.roots || this.roots || [];
            this.updateDrivesList();
            this.updateRootsList();
            // 不再自动 navigateTo，避免调用已删除的文件浏览UI
        } catch (err) {
            console.error('加载驱动器失败:', err);
        }
    }

    updateDrivesList() {
        const container = document.getElementById('drivesList');
        if (!container) return;
        container.innerHTML = this.drives.map(drive => `
            <div class="nav-item" onclick="lingxi.navigateTo('${this._jsStr(drive.path)}')">
                <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M4 4h16v16H4V4zm2 4v10h12V8H6z"/>
                </svg>
                <span>${this.escapeHtml(drive.name)}</span>
            </div>
        `).join('');
    }

    updateRootsList() {
        const container = document.getElementById('rootsList');
        if (!container) return;
        if (!this.roots.length) {
            container.innerHTML = `<div class="nav-empty">暂无，点击 + 添加</div>`;
            return;
        }
        container.innerHTML = this.roots.map((r, idx) => `
            <div class="nav-item" title="${this.escapeHtml(r.path)}">
              <span style="flex:1;cursor:pointer;display:flex;align-items:center;gap:6px;"
                    onclick="lingxi.navigateTo('${this._jsStr(r.path)}')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                <span>${this.escapeHtml(r.name || r.path)}</span>
              </span>
              <button class="nav-remove" onclick="lingxi.removeRoot(${idx})" title="移除">×</button>
            </div>
        `).join('');
    }

    async loadTags() {
        try {
            const res = await fetch('/api/tags');
            const data = await res.json();
            this.tags = data.tags || [];
        } catch (err) {
            console.error('加载标签失败:', err);
        }
    }

    async addRoot() {
        const path = await this.pickDirectory('选择要添加的目录');
        if (!path) return;
        const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
        this.roots.push({ name, path });
        await this.saveRoots();
        this.updateRootsList();
        this.showToast('已添加', 'success');
    }

    async removeRoot(idx) {
        if (!confirm('确定要移除这个根目录吗？（不会删除实际文件）')) return;
        this.roots.splice(idx, 1);
        await this.saveRoots();
        this.updateRootsList();
    }

    async saveRoots() {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roots: this.roots })
        });
    }

    async navigateTo(path, addToHistory = true) {
        this.currentSection = null;
        try {
            const res = await fetch('/api/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: path,
                    sort_by: this.sortBy,
                    sort_desc: this.sortDesc
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();

            if (addToHistory) {
                this.addToHistory(path);
            }

            this.currentPath = path;
            this.currentItems = data.items || [];
            this.selectedFiles.clear();
            this.lastSelectedPath = null;
            this.renderFiles(this.currentItems);
            this.updateBreadcrumb(data.breadcrumb || []);
            this.updateToolbar();
            this.updateSelectionBar();
            this.setStatus(`${data.count || 0} 项`);
        } catch (err) {
            this.showToast(`无法访问目录: ${err.message}`, 'error');
            console.error('导航失败:', err);
        }
    }

    addToHistory(path) {
        // 跳过和当前同一路径
        if (this.historyStack[this.historyIndex] === path) return;
        this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
        this.historyStack.push(path);
        this.historyIndex = this.historyStack.length - 1;
        this.updateToolbar();
    }

    goBack() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.navigateTo(this.historyStack[this.historyIndex], false);
        }
    }

    goForward() {
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyIndex++;
            this.navigateTo(this.historyStack[this.historyIndex], false);
        }
    }

    goUp() {
        if (!this.currentPath) return;
        const parent = this.getParentPath(this.currentPath);
        if (parent && parent !== this.currentPath) {
            this.navigateTo(parent);
        }
    }

    getParentPath(path) {
        if (!path) return '';
        // 处理 Windows 盘符根目录：C:\ 无上级
        if (/^[A-Za-z]:[\\/]?$/.test(path)) return '';
        const normalized = path.replace(/[\\/]+$/, '');
        const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
        if (idx < 0) return '';
        let parent = normalized.substring(0, idx);
        // Windows: C: -> C:\
        if (/^[A-Za-z]:$/.test(parent)) parent = parent + '\\';
        return parent;
    }

    renderFiles(items) {
        const container = document.getElementById('fileGrid');
        const empty = document.getElementById('fileEmpty');

        // 视图模式 class
        container.className = `file-${this.viewMode}`;

        if (!items || items.length === 0) {
            container.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        container.innerHTML = items.map(item => this.renderFileItem(item)).join('');
    }

    renderFileItem(item) {
        const isSelected = this.selectedFiles.has(item.path);
        const isFavorite = item.favorite;
        const tagsHtml = (item.tags || []).map(tag =>
            `<span class="file-tag" style="background:${this.escapeHtml(tag.color)}">${this.escapeHtml(tag.name)}</span>`
        ).join('');

        const iconHtml = this.getFileIcon(item);
        const pathAttr = this.escapeHtml(item.path);
        const pathJs = this._jsStr(item.path);

        return `
            <div class="file-item ${isSelected ? 'selected' : ''} ${isFavorite ? 'favorite' : ''}"
                 data-path="${pathAttr}"
                 data-is-dir="${item.is_dir ? '1' : '0'}"
                 data-kind="${this.escapeHtml(item.kind || 'other')}"
                 onclick="lingxi.toggleSelect('${pathJs}', event)"
                 ondblclick="lingxi.openItem('${pathJs}')"
                 oncontextmenu="lingxi.handleItemContextMenu(event, '${pathJs}')">
                <div class="file-icon ${this.escapeHtml(item.kind || 'other')}">
                    ${iconHtml}
                </div>
                <div class="file-info">
                    <div class="file-name" title="${this.escapeHtml(item.name)}">${this.escapeHtml(item.name)}</div>
                    <div class="file-meta">
                        ${item.is_dir ? '文件夹' : this.escapeHtml(item.size_human || '')}
                        ${item.mtime_human ? ' · ' + this.escapeHtml(item.mtime_human) : ''}
                    </div>
                    ${tagsHtml ? `<div class="file-tags">${tagsHtml}</div>` : ''}
                </div>
            </div>
        `;
    }

    getFileIcon(item) {
        if (item.is_dir) {
            return '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
        }
        // 图片走缩略图
        if (item.kind === 'image') {
            const url = `/api/thumb?path=${encodeURIComponent(item.path)}&size=128`;
            return `<img class="thumb" src="${url}" loading="lazy" onerror="this.outerHTML='🖼️'" alt="">`;
        }
        const icons = {
            video: '🎬',
            audio: '🎵',
            text: '📄',
            code: '💻',
            document: '📋',
            archive: '📦',
            design: '🎨',
            game: '🎮',
            other: '📎'
        };
        return `<span class="emoji-icon">${icons[item.kind] || icons.other}</span>`;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    /** 转义用于嵌入单引号字符串的 JS 字面量（路径含反斜杠） */
    _jsStr(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    updateBreadcrumb(breadcrumb) {
        const container = document.getElementById('breadcrumb');
        if (!breadcrumb || breadcrumb.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = breadcrumb.map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            return `
                <span class="breadcrumb-item ${isLast ? 'active' : ''}"
                      onclick="lingxi.navigateTo('${this._jsStr(item.path)}')">
                    ${this.escapeHtml(item.name)}
                </span>
                ${!isLast ? '<span class="breadcrumb-sep">/</span>' : ''}
            `;
        }).join('');
    }

    updateToolbar() {
        const btnBack = document.getElementById('btnBack');
        const btnFwd = document.getElementById('btnForward');
        if (btnBack) btnBack.disabled = this.historyIndex <= 0;
        if (btnFwd) btnFwd.disabled = this.historyIndex >= this.historyStack.length - 1;

        ['grid', 'list', 'detail'].forEach(view => {
            const btn = document.querySelector(`[data-view="${view}"]`);
            if (btn) btn.classList.toggle('active', this.viewMode === view);
        });

        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) sortSelect.value = this.sortBy;
        const btnSortDir = document.getElementById('btnSortDir');
        if (btnSortDir) {
            btnSortDir.innerHTML = this.sortDesc ?
                '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/></svg>' :
                '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 6h6V4H3v2zm0 8h12v-2H3v2zm0 7h18v-2H3v2z"/></svg>';
            btnSortDir.title = this.sortDesc ? '倒序' : '正序';
        }
    }

    updateUI() {
        this.updateToolbar();
        this.updateSelectionBar();
    }

    setStatus(text) {
        const el = document.getElementById('statusLeft');
        if (el) el.textContent = text;
    }

    /* ====================== 选择逻辑 ====================== */

    toggleSelect(path, event) {
        if (event && (event.ctrlKey || event.metaKey)) {
            if (this.selectedFiles.has(path)) this.selectedFiles.delete(path);
            else this.selectedFiles.add(path);
            this.lastSelectedPath = path;
        } else if (event && event.shiftKey && this.lastSelectedPath) {
            this.selectRange(this.lastSelectedPath, path);
        } else {
            this.selectedFiles.clear();
            this.selectedFiles.add(path);
            this.lastSelectedPath = path;
        }
        this.updateSelection();
    }

    selectRange(fromPath, toPath) {
        const items = Array.from(document.querySelectorAll('.file-item'));
        const a = items.findIndex(it => it.dataset.path === fromPath);
        const b = items.findIndex(it => it.dataset.path === toPath);
        if (a === -1 || b === -1) {
            this.selectedFiles.add(toPath);
            return;
        }
        const [s, e] = a < b ? [a, b] : [b, a];
        for (let i = s; i <= e; i++) {
            this.selectedFiles.add(items[i].dataset.path);
        }
    }

    selectAll() {
        this.selectedFiles.clear();
        document.querySelectorAll('.file-item').forEach(it => this.selectedFiles.add(it.dataset.path));
        this.updateSelection();
    }

    clearSelection() {
        this.selectedFiles.clear();
        this.updateSelection();
    }

    updateSelection() {
        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.toggle('selected', this.selectedFiles.has(item.dataset.path));
        });
        this.updateSelectionBar();

        // 单选时打开详情面板
        if (this.selectedFiles.size === 1) {
            this.showDetails(Array.from(this.selectedFiles)[0]);
        }
    }

    updateSelectionBar() {
        const bar = document.getElementById('selectionBar');
        const text = document.getElementById('selectionText');
        if (!bar || !text) return;
        if (this.selectedFiles.size > 0) {
            bar.classList.remove('hidden');
            text.textContent = `已选 ${this.selectedFiles.size} 项`;
        } else {
            bar.classList.add('hidden');
        }
    }

    /* ====================== 打开文件/文件夹 ====================== */

    openSelected() {
        if (this.selectedFiles.size === 0) return;
        this.selectedFiles.forEach(p => this.openSingleItem(p));
    }

    openItem(path) {
        this.openSingleItem(path);
    }

    openSingleItem(path) {
        // 优先从 DOM 里读取 is-dir 标志，其次从 currentItems 查
        const el = document.querySelector(`.file-item[data-path="${CSS.escape(path)}"]`);
        let isDir = false;
        if (el) {
            isDir = el.dataset.isDir === '1';
        } else {
            const item = this.currentItems.find(i => i.path === path);
            isDir = !!(item && item.is_dir);
        }
        if (isDir) {
            this.navigateTo(path);
        } else {
            this.openFile(path);
        }
    }

    async openFile(path) {
        try {
            fetch('/api/recent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            }).catch(() => {});
            const res = await fetch('/api/open_file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const data = await res.json();
            if (!data.ok) {
                this.showToast(data.error || '打开失败', 'error');
            }
        } catch (err) {
            this.showToast('打开文件失败', 'error');
        }
    }

    /* ====================== 右键菜单 ====================== */

    handleItemContextMenu(e, path) {
        e.preventDefault();
        e.stopPropagation();
        // 若右键项未选中，则改为单选该项
        if (!this.selectedFiles.has(path)) {
            this.selectedFiles.clear();
            this.selectedFiles.add(path);
            this.lastSelectedPath = path;
            this.updateSelection();
        }
        this.showContextMenu(e);
    }

    showContextMenu(e) {
        e.preventDefault();
        const menu = document.getElementById('contextMenu');
        if (!menu) return;
        const hasSelection = this.selectedFiles.size > 0;
        const single = this.selectedFiles.size === 1;

        menu.innerHTML = `
            ${hasSelection ? `
                <div class="context-item" onclick="lingxi.openSelected()">打开</div>
                <div class="context-item" onclick="lingxi.revealInExplorer()">在资源管理器中显示</div>
                <div class="context-sep"></div>
                ${single ? '<div class="context-item" onclick="lingxi.renameSelected()">重命名 (F2)</div>' : ''}
                <div class="context-item" onclick="lingxi.toggleFavorite()">⭐ 收藏/取消收藏</div>
                <div class="context-item" onclick="lingxi.openTagModal()">🏷️ 标签</div>
                <div class="context-sep"></div>
                <div class="context-item" onclick="lingxi.copySelected()">复制 (Ctrl+C)</div>
                <div class="context-item" onclick="lingxi.cutSelected()">剪切 (Ctrl+X)</div>
                ${this.clipboard ? `<div class="context-item" onclick="lingxi.pasteClipboard()">粘贴到此处</div>` : ''}
                <div class="context-item danger" onclick="lingxi.deleteSelected()">删除 (Del)</div>
                <div class="context-sep"></div>
                <div class="context-item" onclick="lingxi.aiRenameSelection()">🤖 AI 重命名</div>
                ${single ? '<div class="context-item" onclick="lingxi.aiDescribeSelected()">🧠 AI 内容描述</div>' : ''}
            ` : `
                ${this.clipboard ? `<div class="context-item" onclick="lingxi.pasteClipboard()">粘贴到此处</div>` : ''}
                <div class="context-item" onclick="lingxi.createNewFolder()">新建文件夹</div>
                <div class="context-item" onclick="lingxi.refresh()">刷新</div>
            `}
        `;

        // 位置修正：避免超出窗口
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = e.pageX, y = e.pageY;
        menu.classList.remove('hidden');
        const rect = menu.getBoundingClientRect();
        if (x + rect.width > vw) x = vw - rect.width - 4;
        if (y + rect.height > vh) y = vh - rect.height - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }

    hideContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (menu) menu.classList.add('hidden');
    }

    /* ====================== 搜索 ====================== */

    handleSearch(e) {
        const query = (e.target.value || '').trim();
        const clearBtn = document.getElementById('searchClear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !query);

        if (!query) {
            if (this.currentPath) this.navigateTo(this.currentPath, false);
            return;
        }
        if (query.length >= 2) {
            this.performSearch(query);
        }
    }

    async performSearch(query) {
        if (!this.currentPath) {
            this.showToast('请先进入一个目录再搜索', 'warning');
            return;
        }
        try {
            const res = await fetch('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    root: this.currentPath,
                    max_results: 200
                })
            });
            const data = await res.json();
            if (data.error) {
                this.showToast(data.error, 'error');
                return;
            }
            this.currentItems = data.items || [];
            this.renderFiles(this.currentItems);
            this.setStatus(`搜索: ${this.currentItems.length} 项${data.truncated ? '（已截断）' : ''}`);
        } catch (err) {
            console.error('搜索失败:', err);
            this.showToast('搜索失败', 'error');
        }
    }

    clearSearch() {
        const input = document.getElementById('searchInput');
        if (!input) return;
        input.value = '';
        const cb = document.getElementById('searchClear');
        if (cb) cb.classList.add('hidden');
        if (this.currentPath) this.navigateTo(this.currentPath, false);
    }

    /* ====================== 视图/排序 ====================== */

    setView(mode) {
        this.viewMode = mode;
        document.querySelectorAll('.vs-btn').forEach(btn => btn.classList.remove('active'));
        const btn = document.querySelector(`[data-view="${mode}"]`);
        if (btn) btn.classList.add('active');
        this.renderFiles(this.currentItems);
        this.updateToolbar();
    }

    setSort(field) {
        this.sortBy = field;
        if (this.currentPath) this.navigateTo(this.currentPath, false);
    }

    toggleSortDir() {
        this.sortDesc = !this.sortDesc;
        if (this.currentPath) this.navigateTo(this.currentPath, false);
    }

    refresh() {
        if (this.currentSection) {
            this.navigateToSection(this.currentSection);
        } else if (this.currentPath) {
            this.navigateTo(this.currentPath, false);
        }
    }

    /* ====================== 侧边栏导航 ====================== */

    async navigateToSection(section) {
        this.currentSection = section;
        document.querySelectorAll('.nav-item[data-nav]').forEach(n => {
            n.classList.toggle('active', n.dataset.nav === section);
        });
        this.selectedFiles.clear();

        if (section === 'recent') {
            await this.loadRecent();
        } else if (section === 'favorites') {
            await this.loadFavorites();
        } else if (section === 'tags') {
            await this.showTagsView();
        }
    }

    async loadRecent() {
        try {
            const res = await fetch('/api/recent?limit=100');
            const data = await res.json();
            const items = (data.items || []).map(r => ({
                name: r.name,
                path: r.path,
                is_dir: false,
                size: 0,
                size_human: '',
                mtime: r.accessed_at,
                mtime_human: new Date(r.accessed_at * 1000).toLocaleString('zh-CN'),
                kind: 'other',
                tags: [],
                favorite: false
            }));
            this.currentItems = items;
            this.currentPath = '';
            this.renderFiles(items);
            this.updateBreadcrumb([{ name: '最近访问', path: '' }]);
            this.setStatus(`最近访问 · ${items.length} 项`);
        } catch (err) {
            this.showToast('加载失败', 'error');
        }
    }

    async loadFavorites() {
        try {
            const res = await fetch('/api/favorites');
            const data = await res.json();
            const items = (data.items || []).map(r => ({
                name: r.name,
                path: r.path,
                is_dir: !!r.is_dir,
                size: 0,
                size_human: '',
                mtime: r.added_at,
                mtime_human: '收藏于 ' + new Date(r.added_at * 1000).toLocaleDateString('zh-CN'),
                kind: r.is_dir ? 'folder' : 'other',
                tags: [],
                favorite: true
            }));
            this.currentItems = items;
            this.currentPath = '';
            this.renderFiles(items);
            this.updateBreadcrumb([{ name: '收藏', path: '' }]);
            this.setStatus(`收藏 · ${items.length} 项`);
        } catch (err) {
            this.showToast('加载失败', 'error');
        }
    }

    async showTagsView() {
        await this.loadTags();
        const container = document.getElementById('fileGrid');
        const empty = document.getElementById('fileEmpty');
        empty.classList.add('hidden');
        container.className = 'tag-board';
        if (!this.tags.length) {
            container.innerHTML = `<div class="ai-empty">暂无标签。右键文件或选择文件后点击"标签"来创建。</div>`;
        } else {
            container.innerHTML = this.tags.map(t => `
                <div class="tag-card" style="border-left:4px solid ${this.escapeHtml(t.color)}">
                    <div class="tag-card-name">${this.escapeHtml(t.name)}</div>
                    <div class="tag-card-count">${t.count || 0} 个文件</div>
                    <button class="btn-sm danger" onclick="lingxi.deleteTag(${t.id})">删除</button>
                </div>
            `).join('');
        }
        this.updateBreadcrumb([{ name: '标签', path: '' }]);
        this.setStatus(`${this.tags.length} 个标签`);
    }

    /* ====================== 详情面板 ====================== */

    async showDetails(path) {
        const panel = document.getElementById('detailsPanel');
        const title = document.getElementById('detailsTitle');
        const body = document.getElementById('detailsBody');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        this.currentPreviewPath = path;
        const name = path.split(/[\\/]/).pop() || path;
        title.textContent = name;

        const item = this.currentItems.find(i => i.path === path);
        const isImage = item && item.kind === 'image';
        const isText = item && (item.kind === 'text' || item.kind === 'code');
        const isDir = item && item.is_dir;

        let html = `
            <div class="detail-section">
                <div class="detail-row"><span class="detail-label">名称:</span> <span>${this.escapeHtml(name)}</span></div>
                <div class="detail-row"><span class="detail-label">路径:</span> <span class="detail-path">${this.escapeHtml(path)}</span></div>
                ${item ? `
                    <div class="detail-row"><span class="detail-label">类型:</span> <span>${isDir ? '文件夹' : this.escapeHtml(item.kind)}</span></div>
                    ${!isDir ? `<div class="detail-row"><span class="detail-label">大小:</span> <span>${this.escapeHtml(item.size_human)}</span></div>` : ''}
                    <div class="detail-row"><span class="detail-label">修改:</span> <span>${this.escapeHtml(item.mtime_human)}</span></div>
                ` : ''}
            </div>
        `;

        if (isImage) {
            html += `<div class="detail-preview"><img src="/api/raw?path=${encodeURIComponent(path)}" alt=""></div>`;
        } else if (isText && item.size < 200000) {
            html += `<div class="detail-preview"><pre id="textPreview">加载中...</pre></div>`;
        }

        html += `
            <div class="detail-actions">
                <button class="btn-sm" onclick="lingxi.openFile('${this._jsStr(path)}')">打开</button>
                <button class="btn-sm" onclick="lingxi.revealPath('${this._jsStr(path)}')">在资源管理器中显示</button>
                <button class="btn-sm" onclick="lingxi.aiDescribePath('${this._jsStr(path)}')">🧠 AI 描述</button>
            </div>
            <div id="aiDescribeBox" class="ai-desc-box"></div>
        `;

        body.innerHTML = html;

        if (isText && item.size < 200000) {
            try {
                const res = await fetch('/api/preview_text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, max_bytes: 100000 })
                });
                const d = await res.json();
                const pre = document.getElementById('textPreview');
                if (pre) pre.textContent = d.content || d.error || '';
            } catch (_) {}
        }
    }

    closeDetails() {
        const panel = document.getElementById('detailsPanel');
        if (panel) panel.classList.add('hidden');
        this.currentPreviewPath = null;
    }

    /* ====================== 文件操作 ====================== */

    renameSelected() {
        if (this.selectedFiles.size !== 1) {
            this.showToast('请选中单个文件再重命名', 'warning');
            return;
        }
        const path = Array.from(this.selectedFiles)[0];
        this.openRenameModal(path);
    }

    openRenameModal(path) {
        const modal = document.getElementById('renameModal');
        const oldName = document.getElementById('renameOld');
        const input = document.getElementById('renameInput');
        const name = path.split(/[\\/]/).pop();
        oldName.textContent = name;
        input.value = name;
        modal.classList.remove('hidden');
        // 选中文件名（不含扩展名）方便修改
        setTimeout(() => {
            input.focus();
            const dot = name.lastIndexOf('.');
            if (dot > 0) input.setSelectionRange(0, dot);
            else input.select();
        }, 50);
    }

    async confirmRename() {
        const input = document.getElementById('renameInput');
        const newName = input.value.trim();
        if (!newName) {
            this.showToast('请输入新名称', 'warning');
            return;
        }
        const path = Array.from(this.selectedFiles)[0];
        try {
            const res = await fetch('/api/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ src: path, new_name: newName })
            });
            const data = await res.json();
            if (data.ok) {
                this.showToast('重命名成功', 'success');
                this.closeRenameModal();
                this.refresh();
            } else {
                this.showToast(data.error || '重命名失败', 'error');
            }
        } catch (err) {
            this.showToast('重命名失败', 'error');
        }
    }

    closeRenameModal() {
        document.getElementById('renameModal').classList.add('hidden');
    }

    async deleteSelected() {
        if (this.selectedFiles.size === 0) {
            this.showToast('请选择要删除的文件', 'warning');
            return;
        }
        if (!confirm(`确定要将 ${this.selectedFiles.size} 个项目移至回收站吗？`)) return;
        try {
            const res = await fetch('/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcs: Array.from(this.selectedFiles), permanent: false })
            });
            const data = await res.json();
            const allOk = (data.results || []).every(r => r.ok);
            if (allOk) {
                this.showToast('已移至回收站', 'success');
            } else {
                this.showToast('部分项目删除失败', 'warning');
            }
            this.selectedFiles.clear();
            this.refresh();
        } catch (err) {
            this.showToast('删除失败', 'error');
        }
    }

    copySelected() {
        if (this.selectedFiles.size === 0) return;
        this.clipboard = { mode: 'copy', paths: Array.from(this.selectedFiles) };
        this.showToast(`已复制 ${this.clipboard.paths.length} 项`, 'info');
    }

    cutSelected() {
        if (this.selectedFiles.size === 0) return;
        this.clipboard = { mode: 'cut', paths: Array.from(this.selectedFiles) };
        this.showToast(`已剪切 ${this.clipboard.paths.length} 项`, 'info');
    }

    async pasteClipboard() {
        if (!this.clipboard || !this.currentPath) return;
        const endpoint = this.clipboard.mode === 'cut' ? '/api/move' : '/api/copy';
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcs: this.clipboard.paths, dst_dir: this.currentPath })
            });
            const data = await res.json();
            if (data.error) {
                this.showToast(data.error, 'error');
                return;
            }
            this.showToast(`已${this.clipboard.mode === 'cut' ? '移动' : '复制'}`, 'success');
            if (this.clipboard.mode === 'cut') this.clipboard = null;
            this.refresh();
        } catch (err) {
            this.showToast('粘贴失败', 'error');
        }
    }

    async createNewFolder() {
        const name = prompt('输入新文件夹名称:');
        if (!name) return;
        try {
            const res = await fetch('/api/mkdir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent: this.currentPath, name })
            });
            const data = await res.json();
            if (data.ok) {
                this.showToast('已创建', 'success');
                this.refresh();
            } else {
                this.showToast(data.error || '创建失败', 'error');
            }
        } catch (err) {
            this.showToast('创建失败', 'error');
        }
    }

    async moveSelection() {
        if (this.selectedFiles.size === 0) return;
        const dst = await this.pickDirectory('选择目标目录');
        if (!dst) return;
        try {
            const res = await fetch('/api/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcs: Array.from(this.selectedFiles), dst_dir: dst })
            });
            const data = await res.json();
            if (data.error) this.showToast(data.error, 'error');
            else { this.showToast('移动完成', 'success'); this.refresh(); }
        } catch (_) {
            this.showToast('移动失败', 'error');
        }
    }

    async copySelection() {
        if (this.selectedFiles.size === 0) return;
        const dst = await this.pickDirectory('选择复制到');
        if (!dst) return;
        try {
            const res = await fetch('/api/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcs: Array.from(this.selectedFiles), dst_dir: dst })
            });
            const data = await res.json();
            if (data.error) this.showToast(data.error, 'error');
            else { this.showToast('复制完成', 'success'); }
        } catch (_) {
            this.showToast('复制失败', 'error');
        }
    }

    async toggleFavorite() {
        if (this.selectedFiles.size === 0) return;
        for (const p of this.selectedFiles) {
            await fetch('/api/favorites/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: p })
            });
        }
        this.showToast('已更新收藏状态', 'success');
        this.refresh();
    }

    async revealInExplorer() {
        if (this.selectedFiles.size === 0) return;
        const path = Array.from(this.selectedFiles)[0];
        this.revealPath(path);
    }

    async revealPath(path) {
        try {
            await fetch('/api/open_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
        } catch (_) {}
    }

    /* ====================== 撤销 ====================== */

    async undoLast() {
        try {
            const res = await fetch('/api/history?limit=1');
            const data = await res.json();
            const last = (data.items || []).find(i => !i.undone);
            if (!last) {
                this.showToast('没有可撤销的操作', 'info');
                return;
            }
            const r = await fetch('/api/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_id: last.batch_id || '', id: last.batch_id ? null : last.id })
            });
            const d = await r.json();
            if (d.results && d.results.some(x => x.ok)) {
                this.showToast('已撤销', 'success');
                this.refresh();
            } else {
                const err = (d.results && d.results[0] && d.results[0].error) || '撤销失败';
                this.showToast(err, 'warning');
            }
        } catch (err) {
            this.showToast('撤销失败', 'error');
        }
    }

    /* ====================== AI 功能 ====================== */

    aiRenameSelection() {
        if (this.selectedFiles.size === 0) {
            this.showToast('请先选择文件', 'warning');
            return;
        }
        if (!this.config.ai || !this.config.ai.api_key_set) {
            this.showToast('请先在设置中配置 AI API Key', 'warning');
            this.openSettings();
            return;
        }
        this.openAITools();
        this.aiResults = [];
        const table = document.getElementById('aiResultTable');
        if (table) table.innerHTML = '';
        const btnApply = document.getElementById('btnAiApply');
        if (btnApply) btnApply.disabled = true;

        if (!this.socket || !this.socket.connected) {
            this.showToast('WebSocket 未连接', 'error');
            return;
        }
        this.aiTaskId = `rename_${Date.now()}`;
        this.socket.emit('ai_batch_rename', {
            task_id: this.aiTaskId,
            files: Array.from(this.selectedFiles),
            apply: false
        });
    }

    aiPreview() {
        this.aiRenameSelection();
    }

    aiApplyRename() {
        const applyList = this.aiResults.filter(r => r.ok && r.new_path && r.path !== r.new_path);
        if (applyList.length === 0) {
            this.showToast('没有可应用的重命名', 'warning');
            return;
        }
        if (!confirm(`确认对 ${applyList.length} 个文件应用 AI 推荐名？`)) return;

        // 顺序调用 /api/rename
        (async () => {
            let ok = 0, fail = 0;
            for (const r of applyList) {
                try {
                    const newName = (r.new_path.split(/[\\/]/).pop()) || r.suggest;
                    const resp = await fetch('/api/rename', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ src: r.path, new_name: newName })
                    });
                    const d = await resp.json();
                    if (d.ok) ok++; else fail++;
                } catch (_) { fail++; }
            }
            this.showToast(`完成：成功 ${ok}，失败 ${fail}`, fail ? 'warning' : 'success');
            this.refresh();
        })();
    }

    aiCancel() {
        if (this.aiTaskId && this.socket) {
            this.socket.emit('ai_cancel', { task_id: this.aiTaskId });
            this.showToast('已请求取消', 'info');
        }
    }

    updateAIProgress(data) {
        const progress = document.getElementById('aiProgress');
        const fill = document.getElementById('aiProgressFill');
        const text = document.getElementById('aiProgressText');
        const percent = document.getElementById('aiProgressPercent');
        const btnApply = document.getElementById('btnAiApply');
        if (!progress) return;

        if (data.status === 'done') {
            if (fill) fill.style.width = '100%';
            if (percent) percent.textContent = '100%';
            if (text) text.textContent = '完成';
            setTimeout(() => progress.classList.add('hidden'), 800);
            if (btnApply) btnApply.disabled = this.aiResults.filter(r => r.ok).length === 0;
            return;
        }
        if (data.status === 'cancelled') {
            if (text) text.textContent = '已取消';
            setTimeout(() => progress.classList.add('hidden'), 500);
            return;
        }
        progress.classList.remove('hidden');
        const pct = Math.round(data.percent || 0);
        if (fill) fill.style.width = `${pct}%`;
        if (text) text.textContent = `处理: ${data.file || ''} (${data.current}/${data.total})`;
        if (percent) percent.textContent = `${pct}%`;
    }

    addAIResultItem(data) {
        const table = document.getElementById('aiResultTable');
        if (!table) return;
        if (table.querySelector('.ai-empty')) table.innerHTML = '';
        const item = data.item || {};
        this.aiResults.push(item);
        const row = document.createElement('div');
        row.className = 'ai-result-row';
        row.innerHTML = `
            <div class="ai-original">${this.escapeHtml(item.name || '')}</div>
            <div class="ai-arrow">→</div>
            <div class="ai-suggest">${this.escapeHtml(item.suggest || item.error || '')}</div>
            <div class="ai-status">${item.ok ? '✅' : '❌'}</div>
        `;
        table.appendChild(row);
    }

    async aiDescribeSelected() {
        if (this.selectedFiles.size !== 1) return;
        const path = Array.from(this.selectedFiles)[0];
        this.aiDescribePath(path);
    }

    async aiDescribePath(path) {
        const box = document.getElementById('aiDescribeBox');
        if (box) box.innerHTML = '<span class="loading">🧠 AI 思考中...</span>';
        try {
            const res = await fetch('/api/ai/describe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const d = await res.json();
            if (d.ok) {
                if (box) box.innerHTML = `<div class="ai-desc">🧠 ${this.escapeHtml(d.description)}</div>`;
                else this.showToast(d.description, 'info');
            } else {
                if (box) box.innerHTML = `<span class="error">${this.escapeHtml(d.error)}</span>`;
                else this.showToast(d.error || '失败', 'error');
            }
        } catch (err) {
            this.showToast('AI 描述失败', 'error');
        }
    }

    async aiSuggestCurrent() {
        // 在重命名弹窗中点击 AI 推荐
        if (this.selectedFiles.size !== 1) return;
        const path = Array.from(this.selectedFiles)[0];
        const input = document.getElementById('renameInput');
        const old = input.value;
        input.value = '⏳ AI 生成中...';
        input.disabled = true;
        try {
            const res = await fetch('/api/ai/suggest_name', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const d = await res.json();
            if (d.ok) {
                input.value = d.suggest;
            } else {
                input.value = old;
                this.showToast(d.error || 'AI 推荐失败', 'error');
            }
        } catch (_) {
            input.value = old;
            this.showToast('AI 推荐失败', 'error');
        } finally {
            input.disabled = false;
            input.focus();
        }
    }

    /* ====================== 标签 ====================== */

    async openTagModal() {
        await this.loadTags();
        const modal = document.getElementById('tagModal');
        const list = document.getElementById('tagListInModal');
        if (!modal || !list) return;

        // 获取选中文件已有的标签（简化：展示所有标签，用户多选勾选）
        list.innerHTML = this.tags.map(t => `
            <label class="tag-pick">
                <input type="checkbox" value="${t.id}" data-color="${this.escapeHtml(t.color)}">
                <span class="tag-chip" style="background:${this.escapeHtml(t.color)}">${this.escapeHtml(t.name)}</span>
                <span class="tag-count">(${t.count || 0})</span>
            </label>
        `).join('') || '<div class="ai-empty">暂无标签，先创建一个吧</div>';
        modal.classList.remove('hidden');
    }

    closeTagModal() {
        const m = document.getElementById('tagModal');
        if (m) m.classList.add('hidden');
    }

    async createTag() {
        const name = document.getElementById('newTagName').value.trim();
        const color = document.getElementById('newTagColor').value;
        if (!name) { this.showToast('请输入标签名', 'warning'); return; }
        try {
            const res = await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });
            const d = await res.json();
            if (d.ok) {
                this.showToast('已创建', 'success');
                document.getElementById('newTagName').value = '';
                await this.openTagModal();
            } else {
                this.showToast(d.error || '创建失败', 'error');
            }
        } catch (_) { this.showToast('创建失败', 'error'); }
    }

    async deleteTag(tid) {
        if (!confirm('删除这个标签吗？（文件上的该标签关联也会被清除）')) return;
        await fetch(`/api/tags/${tid}`, { method: 'DELETE' });
        await this.loadTags();
        if (this.currentSection === 'tags') this.showTagsView();
    }

    async applyTagsToSelection() {
        if (this.selectedFiles.size === 0) {
            this.showToast('请先选择文件', 'warning');
            return;
        }
        const checks = Array.from(document.querySelectorAll('#tagListInModal input[type=checkbox]:checked'));
        const tagIds = checks.map(c => parseInt(c.value, 10));
        for (const p of this.selectedFiles) {
            await fetch('/api/file_tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: p, tag_ids: tagIds })
            });
        }
        this.showToast('已应用标签', 'success');
        this.closeTagModal();
        this.refresh();
    }

    tagSelection() { this.openTagModal(); }

    /* ====================== 设置弹窗 ====================== */

    async openSettings() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        // 填充当前配置
        const ai = this.config.ai || {};
        const byId = id => document.getElementById(id);
        if (byId('ai_api_base')) byId('ai_api_base').value = ai.api_base || '';
        if (byId('ai_api_key')) byId('ai_api_key').value = ai.api_key || '';
        if (byId('ai_model')) byId('ai_model').value = ai.model || '';
        if (byId('ai_vision_model')) byId('ai_vision_model').value = ai.vision_model || '';
        if (byId('dataDir')) byId('dataDir').textContent = '浏览器端不可见，后端 _data 目录';
        modal.classList.remove('hidden');
    }

    closeSettings() {
        const m = document.getElementById('settingsModal');
        if (m) m.classList.add('hidden');
    }

    setSettingsTab(tab) {
        document.querySelectorAll('.st-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelectorAll('.st-panel').forEach(p => p.classList.toggle('active', p.id === 'st-' + tab));
    }

    async saveSettings() {
        const payload = {
            ai: {
                api_base: document.getElementById('ai_api_base').value.trim(),
                api_key: document.getElementById('ai_api_key').value.trim(),
                model: document.getElementById('ai_model').value.trim(),
                vision_model: document.getElementById('ai_vision_model').value.trim(),
                enabled: true
            }
        };
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const d = await res.json();
            if (d.ok) {
                this.showToast('配置已保存', 'success');
                await this.loadConfig();
            } else {
                this.showToast('保存失败', 'error');
            }
        } catch (_) { this.showToast('保存失败', 'error'); }
    }

    async testAI() {
        const box = document.getElementById('aiTestResult');
        if (box) box.innerHTML = '<span class="loading">测试中...</span>';
        // 先保存一下（否则 api_key 是掩码时无法使用）
        await this.saveSettings();
        try {
            const res = await fetch('/api/ai/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const d = await res.json();
            if (d.ok) {
                if (box) box.innerHTML = `<span class="success">✅ 连接成功：${this.escapeHtml(d.reply)}</span>`;
            } else {
                if (box) box.innerHTML = `<span class="error">❌ ${this.escapeHtml(d.error)}</span>`;
            }
        } catch (err) {
            if (box) box.innerHTML = `<span class="error">❌ ${err.message}</span>`;
        }
    }

    async clearCache() {
        if (!confirm('清空缩略图缓存？下次预览时会重新生成。')) return;
        this.showToast('请到 _data/thumbs 手动清空（或重启后自动刷新）', 'info');
    }

    /* ====================== AI 批量工具弹窗 ====================== */

    openAITools() {
        const modal = document.getElementById('aiToolsModal');
        const count = document.getElementById('aiFileCount');
        if (count) count.textContent = `${this.selectedFiles.size} 个文件`;
        if (modal) modal.classList.remove('hidden');
    }

    closeAITools() {
        const m = document.getElementById('aiToolsModal');
        if (m) m.classList.add('hidden');
    }

    /* ====================== 历史 ====================== */

    async toggleHistoryPanel() {
        const m = document.getElementById('historyModal');
        if (!m) return;
        if (m.classList.contains('hidden')) {
            await this.loadHistory();
            m.classList.remove('hidden');
        } else {
            m.classList.add('hidden');
        }
    }

    closeHistoryPanel() {
        const m = document.getElementById('historyModal');
        if (m) m.classList.add('hidden');
    }

    async loadHistory() {
        const body = document.getElementById('historyBody');
        if (!body) return;
        body.innerHTML = '<div class="ai-empty">加载中...</div>';
        try {
            const res = await fetch('/api/history?limit=100');
            const data = await res.json();
            const items = data.items || [];
            if (items.length === 0) {
                body.innerHTML = '<div class="ai-empty">暂无历史记录</div>';
                return;
            }
            body.innerHTML = items.map(h => `
                <div class="history-row ${h.undone ? 'undone' : ''}">
                    <div class="history-action">${this.escapeHtml(h.action)}</div>
                    <div class="history-paths">
                        ${h.src ? `<div class="history-src">${this.escapeHtml(h.src)}</div>` : ''}
                        ${h.dst ? `<div class="history-dst">→ ${this.escapeHtml(h.dst)}</div>` : ''}
                    </div>
                    <div class="history-time">${new Date(h.created_at * 1000).toLocaleString('zh-CN')}</div>
                    <div class="history-actions">
                        ${!h.undone && ['rename', 'move', 'copy', 'mkdir'].includes(h.action) ?
                            `<button class="btn-sm" onclick="lingxi.undoHistoryItem(${h.id})">撤销</button>` :
                            (h.undone ? '<span class="tag-undone">已撤销</span>' : '')}
                    </div>
                </div>
            `).join('');
        } catch (_) {
            body.innerHTML = '<div class="ai-empty">加载失败</div>';
        }
    }

    async undoHistoryItem(id) {
        try {
            const res = await fetch('/api/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const d = await res.json();
            if (d.results && d.results[0] && d.results[0].ok) {
                this.showToast('已撤销', 'success');
                await this.loadHistory();
                this.refresh();
            } else {
                this.showToast((d.results && d.results[0] && d.results[0].error) || '撤销失败', 'warning');
            }
        } catch (_) { this.showToast('撤销失败', 'error'); }
    }

    /* ====================== 重复文件检测 ====================== */

    openDuplicateScan() {
        const m = document.getElementById('dupModal');
        const input = document.getElementById('dupRoot');
        if (input && this.currentPath) input.value = this.currentPath;
        if (m) m.classList.remove('hidden');
    }

    closeDupModal() {
        const m = document.getElementById('dupModal');
        if (m) m.classList.add('hidden');
    }

    async pickDupRoot() {
        const dir = await this.pickDirectory('选择要扫描的目录');
        if (dir) document.getElementById('dupRoot').value = dir;
    }

    async startDupScan() {
        const root = document.getElementById('dupRoot').value.trim();
        if (!root) { this.showToast('请选择目录', 'warning'); return; }
        const summary = document.getElementById('dupSummary');
        const body = document.getElementById('dupBody');
        summary.classList.add('hidden');
        body.innerHTML = '<div class="ai-empty">扫描中...（大目录可能较慢）</div>';
        try {
            const res = await fetch('/api/duplicates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root, min_size: 1024 })
            });
            const d = await res.json();
            if (d.error) {
                body.innerHTML = `<div class="ai-empty">错误：${this.escapeHtml(d.error)}</div>`;
                return;
            }
            summary.classList.remove('hidden');
            summary.innerHTML = `共 <b>${d.total_groups}</b> 组重复，浪费空间 <b>${this.escapeHtml(d.wasted_human)}</b>`;
            if (!d.groups.length) {
                body.innerHTML = '<div class="ai-empty">🎉 没有发现重复文件</div>';
                return;
            }
            body.innerHTML = d.groups.map((g, i) => `
                <div class="dup-group">
                    <div class="dup-group-header">组 ${i + 1} · ${this.escapeHtml(g.size_human)} · ${g.files.length} 个</div>
                    ${g.files.map(f => `
                        <div class="dup-file">
                            <span title="${this.escapeHtml(f.path)}">${this.escapeHtml(f.path)}</span>
                            <button class="btn-sm" onclick="lingxi.revealPath('${this._jsStr(f.path)}')">定位</button>
                            <button class="btn-sm danger" onclick="lingxi.deleteDupFile('${this._jsStr(f.path)}', this)">删除</button>
                        </div>
                    `).join('')}
                </div>
            `).join('');
        } catch (err) {
            body.innerHTML = `<div class="ai-empty">扫描失败：${this.escapeHtml(err.message)}</div>`;
        }
    }

    async deleteDupFile(path, btn) {
        if (!confirm(`将此文件移至回收站？\n${path}`)) return;
        try {
            const res = await fetch('/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcs: [path], permanent: false })
            });
            const d = await res.json();
            if (d.results && d.results[0].ok) {
                btn.closest('.dup-file').style.opacity = '0.4';
                btn.closest('.dup-file').innerHTML = '<span>已删除</span>';
                this.showToast('已移至回收站', 'success');
            } else {
                this.showToast('删除失败', 'error');
            }
        } catch (_) { this.showToast('删除失败', 'error'); }
    }

    /* ====================== Spine 扫描 ====================== */

    openSpineScan() {
        const m = document.getElementById('spineModal');
        const input = document.getElementById('spineRoot');
        if (input && this.currentPath) input.value = this.currentPath;
        if (m) m.classList.remove('hidden');
    }

    closeSpineModal() {
        const m = document.getElementById('spineModal');
        if (m) m.classList.add('hidden');
    }

    async pickSpineRoot() {
        const dir = await this.pickDirectory('选择要扫描的目录');
        if (dir) document.getElementById('spineRoot').value = dir;
    }

    async startSpineScan() {
        const root = document.getElementById('spineRoot').value.trim();
        if (!root) { this.showToast('请选择目录', 'warning'); return; }
        const body = document.getElementById('spineBody');
        body.innerHTML = '<div class="ai-empty">扫描中...</div>';
        try {
            const res = await fetch('/api/spine_scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root })
            });
            const d = await res.json();
            if (d.error) {
                body.innerHTML = `<div class="ai-empty">错误：${this.escapeHtml(d.error)}</div>`;
                return;
            }
            if (!d.groups.length) {
                body.innerHTML = '<div class="ai-empty">未发现 Spine 资源</div>';
                return;
            }
            body.innerHTML = `<div class="spine-summary">共发现 ${d.count} 个 Spine 资源组</div>` +
                d.groups.map(g => `
                    <div class="spine-group">
                        <div class="spine-name">🎮 ${this.escapeHtml(g.name)}</div>
                        <div class="spine-dir" title="${this.escapeHtml(g.dir)}">${this.escapeHtml(g.dir)}</div>
                        <div class="spine-related">
                            ${g.related.map(r => `<span class="spine-file">${this.escapeHtml(r.name)}</span>`).join('')}
                        </div>
                        <button class="btn-sm" onclick="lingxi.navigateTo('${this._jsStr(g.dir)}');lingxi.closeSpineModal();">打开目录</button>
                    </div>
                `).join('');
        } catch (err) {
            body.innerHTML = `<div class="ai-empty">扫描失败：${this.escapeHtml(err.message)}</div>`;
        }
    }

    /* ====================== 目录选择器 ====================== */

    pickDirectory(title = '选择目录') {
        return new Promise((resolve) => {
            const modal = document.getElementById('browserModal');
            const titleEl = document.getElementById('browserTitle');
            if (titleEl) titleEl.textContent = title;
            this.browserState = {
                path: this.currentPath || '',
                resolve
            };
            this._browserLoadDrives();
            this._browserRender(this.currentPath || '');
            modal.classList.remove('hidden');
        });
    }

    _browserLoadDrives() {
        const container = document.getElementById('browserDrives');
        if (!container) return;
        container.innerHTML = this.drives.map(d => `
            <button class="btn-sm" onclick="lingxi.browserNavigate('${this._jsStr(d.path)}')">${this.escapeHtml(d.name)}</button>
        `).join('');
    }

    async _browserRender(path) {
        if (!this.browserState) return;
        this.browserState.path = path;
        const input = document.getElementById('browserPath');
        if (input) input.value = path;
        const list = document.getElementById('browserList');
        list.innerHTML = '<div class="ai-empty">加载中...</div>';
        try {
            const res = await fetch('/api/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, sort_by: 'name', sort_desc: false })
            });
            const d = await res.json();
            if (d.error) {
                list.innerHTML = `<div class="ai-empty">${this.escapeHtml(d.error)}</div>`;
                return;
            }
            const dirs = (d.items || []).filter(i => i.is_dir);
            if (!dirs.length) {
                list.innerHTML = '<div class="ai-empty">（此目录下没有子文件夹）</div>';
                return;
            }
            list.innerHTML = dirs.map(dir => `
                <div class="browser-item" data-path="${this.escapeHtml(dir.path)}" title="${this.escapeHtml(dir.path)}">
                    <span class="browser-item-name">${this.escapeHtml(dir.name)}</span>
                </div>
            `).join('');
        } catch (err) {
            list.innerHTML = `<div class="ai-empty">${this.escapeHtml(err.message)}</div>`;
        }
    }

    browserNavigate(path) {
        this._browserRender(path);
    }

    browserUp() {
        if (!this.browserState) return;
        const parent = this.getParentPath(this.browserState.path);
        if (parent) this.browserNavigate(parent);
    }

    browserConfirm() {
        if (!this.browserState) return;
        const resolve = this.browserState.resolve;
        const path = this.browserState.path;
        this.browserState = null;
        document.getElementById('browserModal').classList.add('hidden');
        resolve(path || null);
    }

    closeBrowser() {
        if (this.browserState) {
            this.browserState.resolve(null);
            this.browserState = null;
        }
        document.getElementById('browserModal').classList.add('hidden');
    }

    /* ====================== 拖拽（保留占位） ====================== */

    handleViewportClick(e) { /* 预留，已在 bindEvents 内处理 */ }
    handleFileDblClick(e) { /* 预留，通过 ondblclick 属性处理 */ }
    handleDrop(e) { e.preventDefault(); /* 文件系统拖入暂不支持 */ }

    /* ====================== 通用工具 ====================== */

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) { console.log(`[${type}] ${message}`); return; }
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span>${this.escapeHtml(message)}</span>
            <button onclick="this.parentElement.remove()">×</button>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, 3000);
    }
}

// 全局实例
let lingxi;
document.addEventListener('DOMContentLoaded', () => {
    lingxi = new LingXiFileManager();
});

/* ====================== HTML 内联调用的全局函数 ====================== */
function navTo(section) { lingxi && lingxi.navigateToSection(section); }
function setView(mode) { lingxi && lingxi.setView(mode); }
function setSort(field) { lingxi && lingxi.setSort(field); }
function toggleSortDir() { lingxi && lingxi.toggleSortDir(); }
function goBack() { lingxi && lingxi.goBack(); }
function goForward() { lingxi && lingxi.goForward(); }
function goUp() { lingxi && lingxi.goUp(); }
function refresh() { lingxi && lingxi.refresh(); }
function clearSearch() { lingxi && lingxi.clearSearch(); }

function aiRenameSelection() { lingxi && lingxi.aiRenameSelection(); }
function aiPreview() { lingxi && lingxi.aiPreview(); }
function aiApplyRename() { lingxi && lingxi.aiApplyRename(); }
function aiCancel() { lingxi && lingxi.aiCancel(); }
function aiSuggestCurrent() { lingxi && lingxi.aiSuggestCurrent(); }

function openAITools() {
    if (!lingxi) return;
    if (lingxi.selectedFiles.size === 0) {
        lingxi.showToast('请先选中文件', 'warning');
        return;
    }
    lingxi.openAITools();
}
function closeAITools() { lingxi && lingxi.closeAITools(); }

function openSettings() { lingxi && lingxi.openSettings(); }
function closeSettings() { lingxi && lingxi.closeSettings(); }
function setSettingsTab(tab) { lingxi && lingxi.setSettingsTab(tab); }
function saveSettings() { lingxi && lingxi.saveSettings(); }
function testAI() { lingxi && lingxi.testAI(); }
function clearCache() { lingxi && lingxi.clearCache(); }

function confirmRename() { lingxi && lingxi.confirmRename(); }
function closeRenameModal() { lingxi && lingxi.closeRenameModal(); }

function moveSelection() { lingxi && lingxi.moveSelection(); }
function copySelection() { lingxi && lingxi.copySelection(); }
function tagSelection() { lingxi && lingxi.tagSelection(); }
function deleteSelection() { lingxi && lingxi.deleteSelected(); }
function clearSelection() { lingxi && lingxi.clearSelection(); }

function addRoot() { lingxi && lingxi.addRoot(); }

function toggleHistoryPanel() { lingxi && lingxi.toggleHistoryPanel(); }
function closeHistoryPanel() { lingxi && lingxi.closeHistoryPanel(); }

function openDuplicateScan() { lingxi && lingxi.openDuplicateScan(); }
function closeDupModal() { lingxi && lingxi.closeDupModal(); }
function pickDupRoot() { lingxi && lingxi.pickDupRoot(); }
function startDupScan() { lingxi && lingxi.startDupScan(); }

function openSpineScan() { lingxi && lingxi.openSpineScan(); }
function closeSpineModal() { lingxi && lingxi.closeSpineModal(); }
function pickSpineRoot() { lingxi && lingxi.pickSpineRoot(); }
function startSpineScan() { lingxi && lingxi.startSpineScan(); }

function closeBrowser() { lingxi && lingxi.closeBrowser(); }
function browserUp() { lingxi && lingxi.browserUp(); }
function browserNavigate(path) { lingxi && lingxi.browserNavigate(path); }
function browserConfirm() { lingxi && lingxi.browserConfirm(); }

function openTagModal() { lingxi && lingxi.openTagModal(); }
function closeTagModal() { lingxi && lingxi.closeTagModal(); }
function createTag() { lingxi && lingxi.createTag(); }
function applyTagsToSelection() { lingxi && lingxi.applyTagsToSelection(); }

function closeDetails() { lingxi && lingxi.closeDetails(); }

function showContextMenu(e) { lingxi && lingxi.showContextMenu(e); }
function hideContextMenu() { lingxi && lingxi.hideContextMenu(); }

// ============ 项目文件整理 ============

let organizeData = null;
let organizeLastBatchId = null;

function openOrganize() {
  document.getElementById('organizeModal').classList.remove('hidden');
  // 如果当前有打开的目录，自动填充
  if (lingxi && lingxi.currentPath) {
    document.getElementById('organizeRoot').value = lingxi.currentPath;
  }
}

function closeOrganize() {
  document.getElementById('organizeModal').classList.add('hidden');
}

function pickOrganizeRoot() {
  if (lingxi) {
    lingxi._browserCallback = (path) => {
      document.getElementById('organizeRoot').value = path;
    };
    lingxi.openBrowser('选择要整理的目录');
  }
}

async function startOrganizeScan() {
  const root = document.getElementById('organizeRoot').value.trim();
  if (!root) {
    showToast('请先选择一个目录', 'warning');
    return;
  }

  const body = document.getElementById('organizeBody');
  body.innerHTML = '<div class="ai-empty">⏳ 正在扫描分类中...</div>';
  document.getElementById('organizeSummary').classList.add('hidden');
  document.getElementById('organizeFooter').classList.add('hidden');

  try {
    const resp = await fetch('/api/organize/scan', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({root})
    });
    const data = await resp.json();
    if (data.error) {
      body.innerHTML = `<div class="ai-empty" style="color:var(--error)">❌ ${data.error}</div>`;
      return;
    }
    organizeData = data;
    renderOrganizeResult(data);
  } catch (e) {
    body.innerHTML = `<div class="ai-empty" style="color:var(--error)">❌ 请求失败: ${e.message}</div>`;
  }
}

function renderOrganizeResult(data) {
  const summary = document.getElementById('organizeSummary');
  const body = document.getElementById('organizeBody');
  const footer = document.getElementById('organizeFooter');

  // 汇总信息
  const cats = data.categories;
  const catCount = Object.keys(cats).length;
  const totalItems = Object.values(cats).reduce((s, arr) => s + arr.length, 0);
  
  summary.innerHTML = `
    <div class="organize-stats">
      <span>📊 共 <strong>${data.stats.total_files}</strong> 个文件</span>
      <span>💾 总计 <strong>${data.stats.total_size_human}</strong></span>
      <span>✅ 已识别 <strong>${data.stats.classified}</strong> 组</span>
      <span>❓ 未分类 <strong>${data.stats.unclassified}</strong> 组</span>
    </div>
  `;
  summary.classList.remove('hidden');

  // 渲染分类列表
  const CATEGORY_META = {
    'completion': {icon: '🎨', name: '完成图', color: '#00b894'},
    'source': {icon: '📐', name: '工程文件', color: '#6c5ce7'},
    'spine_export': {icon: '📦', name: '动画导出', color: '#0984e3'},
    'cutout': {icon: '✂️', name: '切图素材', color: '#fdcb6e'},
    'icon_set': {icon: '🏅', name: '收集栏图标', color: '#e17055'},
    'background': {icon: '🖼️', name: '底图', color: '#00cec9'},
    'process_ai': {icon: '🤖', name: '过程-AI生图', color: '#a29bfe'},
    'process_ref': {icon: '📸', name: '过程-参考截图', color: '#74b9ff'},
    'process_draft': {icon: '📝', name: '过程-草稿迭代', color: '#fab1a0'},
    'package': {icon: '📮', name: '打包交付', color: '#55efc4'},
    'unknown': {icon: '❓', name: '未分类', color: '#636e72'}
  };

  let html = '';
  for (const [catId, files] of Object.entries(cats)) {
    const meta = CATEGORY_META[catId] || {icon: '❓', name: catId, color: '#636e72'};
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const isUnknown = catId === 'unknown';

    html += `
      <div class="organize-group">
        <div class="organize-group-header" onclick="toggleOrganizeGroup(this)">
          <div class="organize-group-title">
            <span class="organize-group-icon">${meta.icon}</span>
            <span class="organize-group-name">${meta.name}</span>
            <span class="organize-group-count">${files.length} 项</span>
            <span class="organize-group-size">${humanSize(totalSize)}</span>
          </div>
          <div class="organize-group-target">
            ${isUnknown ? '<span style="color:var(--text-muted)">不移动</span>' : `→ <code>${CATEGORY_META[catId] ? '_' + meta.name.replace('过程-', '过程文件/') : ''}</code>`}
          </div>
          ${isUnknown && files.length > 0 ? '<button class="btn-sm ai-classify-btn" onclick="aiClassifyFiles()" title="使用AI智能分类未识别文件">🤖 AI辅助分类</button>' : ''}
          <svg class="organize-chevron" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </div>
        <div class="organize-group-files hidden">
    `;
    for (const file of files) {
      html += `
          <label class="organize-file-row">
            <input type="checkbox" data-cat="${catId}" data-path="${file.path.replace(/\\/g, '\\\\').replace(/"/g, '&quot;')}" ${isUnknown ? '' : 'checked'} onchange="updateOrganizeCount()">
            <span class="organize-file-name" title="${file.name}">${file.is_dir ? '📁 ' : ''}${file.name}${file.ai_classified ? ' <span class="ai-badge" title="AI分类: ' + (file.ai_reason || '智能识别') + '">🤖</span>' : ''}</span>
            <span class="organize-file-size">${file.size_human}</span>
          </label>
      `;
    }
    html += `
        </div>
      </div>
    `;
  }

  body.innerHTML = html;
  footer.classList.remove('hidden');
  updateOrganizeCount();

  // 如果有上次 batch_id 显示撤销按钮
  if (organizeLastBatchId) {
    document.getElementById('organizeUndoBtn').style.display = '';
  }
}

function toggleOrganizeGroup(header) {
  const files = header.nextElementSibling;
  files.classList.toggle('hidden');
  header.querySelector('.organize-chevron').classList.toggle('rotated');
}

function updateOrganizeCount() {
  const checks = document.querySelectorAll('#organizeBody input[type=checkbox]:checked');
  document.getElementById('organizeSelectedCount').textContent = `已选 ${checks.length} 项`;
}

function organizeSelectAll() {
  document.querySelectorAll('#organizeBody input[type=checkbox]').forEach(cb => {
    if (cb.dataset.cat !== 'unknown') cb.checked = true;
  });
  updateOrganizeCount();
}

function organizeDeselectAll() {
  document.querySelectorAll('#organizeBody input[type=checkbox]').forEach(cb => cb.checked = false);
  updateOrganizeCount();
}

async function executeOrganize() {
  if (!organizeData) return;
  
  const checks = document.querySelectorAll('#organizeBody input[type=checkbox]:checked');
  if (checks.length === 0) {
    showToast('请至少选择一个文件', 'warning');
    return;
  }

  const moves = [];
  checks.forEach(cb => {
    moves.push({
      path: cb.dataset.path.replace(/\\\\/g, '\\'),
      category: cb.dataset.cat
    });
  });

  if (!confirm(`确认整理 ${moves.length} 个文件/目录？\n文件将移动到对应分类文件夹中。\n（可撤销）`)) {
    return;
  }

  try {
    // 从 #aiProjectInfo 元素的文本中正则提取项目名/关卡名
    const aiInfoText = document.getElementById('aiProjectInfo')?.textContent || '';
    const projectName = (aiInfoText.match(/项目：([^|\n]+)/)?.[1] || '').trim();
    const levelName = (aiInfoText.match(/关卡：([^|\n]+)/)?.[1] || '').trim();
    // root 改为 organizeData.root 的父目录（关卡目录的上级，即项目目录）
    const parentRoot = organizeData.root.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');

    const resp = await fetch('/api/organize/execute', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        root: parentRoot,
        project_name: projectName,
        level_name: levelName,
        moves
      })
    });
    const result = await resp.json();
    if (result.error) {
      showToast(`整理失败: ${result.error}`, 'error');
      return;
    }

    organizeLastBatchId = result.batch_id;
    showToast(`✅ 整理完成！移动了 ${result.moved} 项${result.failed ? `，${result.failed} 项失败` : ''}`, 'success');
    
    // 刷新扫描
    startOrganizeScan();
    
    // 刷新文件视图
    if (lingxi) lingxi.refresh();
  } catch (e) {
    showToast(`请求失败: ${e.message}`, 'error');
  }
}

async function undoOrganize() {
  if (!organizeLastBatchId) return;
  if (!confirm('确认撤销上次整理操作？所有文件将恢复原位。')) return;

  try {
    const resp = await fetch('/api/organize/undo', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({batch_id: organizeLastBatchId})
    });
    const result = await resp.json();
    showToast(`↩ 已撤销 ${result.reverted}/${result.total} 项`, 'success');
    organizeLastBatchId = null;
    document.getElementById('organizeUndoBtn').style.display = 'none';
    startOrganizeScan();
    if (lingxi) lingxi.refresh();
  } catch (e) {
    showToast(`撤销失败: ${e.message}`, 'error');
  }
}

function humanSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// AI辅助分类功能
async function aiClassifyFiles() {
  try {
    const btn = document.querySelector('.ai-classify-btn');
    const originalText = btn.textContent;
    btn.textContent = '🤖 分类中...';
    btn.disabled = true;

    if (!organizeData || !organizeData.categories.unknown) {
      throw new Error('没有未分类的文件');
    }

    const unknownFiles = organizeData.categories.unknown;
    const resp = await fetch('/api/organize/llm_classify', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        root: organizeData.root,
        files: unknownFiles.map(f => ({
          name: f.name,
          path: f.path,
          size_human: f.size_human,
          is_dir: f.is_dir
        }))
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err || 'AI分类请求失败');
    }

    const result = await resp.json();
    
    // 处理AI分类结果
    if (result.results && Array.isArray(result.results)) {
      // 标记已分类的文件
      const classifiedFiles = new Set();
      
      for (const aiResult of result.results) {
        // 找到对应的文件并添加AI分类标记
        const fileIndex = organizeData.categories.unknown.findIndex(f => 
          f.name === aiResult.name && f.path === aiResult.path
        );
        
        if (fileIndex !== -1) {
          const file = organizeData.categories.unknown[fileIndex];
          file.ai_classified = true;
          file.ai_reason = aiResult.reason;
          file.ai_category = aiResult.category;
          classifiedFiles.add(fileIndex);
        }
      }
      
      // 将AI分类的文件移动到对应分组
      for (const fileIndex of [...classifiedFiles].sort((a, b) => b - a)) {
        const file = organizeData.categories.unknown.splice(fileIndex, 1)[0];
        if (!organizeData.categories[file.ai_category]) {
          organizeData.categories[file.ai_category] = [];
        }
        organizeData.categories[file.ai_category].push(file);
      }
      
      // 更新统计数据
      organizeData.stats.classified += classifiedFiles.size;
      organizeData.stats.unclassified = organizeData.categories.unknown.length;
      
      showToast(`🤖 AI已分类 ${classifiedFiles.size} 个文件`, 'success');
      renderOrganizeResult(organizeData);
    }
    
  } catch (e) {
    console.error('AI分类失败:', e);
    showToast(`AI分类失败: ${e.message}`, 'error');
  } finally {
    const btn = document.querySelector('.ai-classify-btn');
    if (btn) {
      btn.textContent = '🤖 AI辅助分类';
      btn.disabled = false;
    }
  }
}

// 项目名自动检测
async function detectProject() {
  try {
    const rootInput = document.getElementById('organizeRoot');
    const root = rootInput.value.trim();
    
    if (!root) {
      showToast('请先输入或选择项目目录', 'warning');
      return;
    }

    const resp = await fetch('/api/organize/detect_project', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ root })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err || '项目识别请求失败');
    }

    const result = await resp.json();
    
    if (result.ok) {
      const infoDiv = document.getElementById('aiProjectInfo');
      const modName = result.module_name || result.level_name || '';
      infoDiv.innerHTML = `
        <div class="project-info">
          <span>📋 项目：${result.project_name || '未知'}</span>
          <span>| 模块：${modName || '未知'}</span>
          ${result.module_type ? `<span>| 类型：${({level:'关卡',home:'主页',common_ui:'通用UI',loading:'加载页',other:'其他'})[result.module_type] || result.module_type}</span>` : ''}
          <span>| 置信度：${result.confidence || '未知'}</span>
          ${result.reasoning ? `<div class="project-reasoning">💡 ${result.reasoning}</div>` : ''}
        </div>
      `;
      infoDiv.classList.remove('hidden');

      // 同步到看板输入框（若存在）
      const projInput = document.getElementById('archiveProjectNameInput');
      const modInput  = document.getElementById('archiveModuleNameInput');
      const typeSel   = document.getElementById('archiveModuleTypeSelect');
      const confEl    = document.getElementById('archiveConfidence');
      const reasonEl  = document.getElementById('archiveReasoning');
      if (projInput && result.project_name) { projInput.value = result.project_name; delete projInput.dataset.userEdited; }
      if (modInput && modName)              { modInput.value  = modName;              delete modInput.dataset.userEdited; }
      if (typeSel && result.module_type) {
        const valid = ['level','home','common_ui','loading','other'];
        typeSel.value = valid.includes(result.module_type) ? result.module_type : 'level';
      }
      if (confEl && result.confidence) {
        confEl.className = `archive-confidence ${result.confidence}`;
        confEl.textContent = `🎯 ${({high:'高置信',medium:'中置信',low:'低置信'})[result.confidence] || result.confidence}`;
      }
      if (reasonEl && result.reasoning) reasonEl.textContent = `💡 ${result.reasoning}`;

      showToast('项目识别成功', 'success');
    } else {
      showToast('未能识别到项目信息', 'warning');
    }
    
  } catch (e) {
    console.error('项目识别失败:', e);
    showToast(`项目识别失败: ${e.message}`, 'error');
  }
}

// ============ 快速归档看板（重写版） ============
//
// 核心数据：
//   archiveData = { root, categories: { <catId>: [files] }, project_name, level_name, ... }
//   archiveFiles = [ { name, path, size_human, is_dir, category(规则推断), archiveCategory(当前归类), ai_classified, ai_reason, ai_content } ]
//
// UI 结构：
//   顶部工具栏：项目名/模块名/模块类型 输入 + 置信度 + AI识图 + 执行归档
//   主卡片网格：7张关键卡（完成图/底图/工程/动画/切图/收集栏图标/打包 + 未分类）
//   折叠抽屉：过程文件（AI生图/参考截图/草稿迭代）

let archiveData = null;
let archiveFiles = [];
let archiveProcessDrawerOpen = false;

// 关键产出卡片（默认展示在主网格）
const ARCHIVE_MAIN_CATS = {
  'completion':   { name: '完成图',     icon: '🎨', desc: '最终效果展示图',            accept: 'JPG/PNG' },
  'background':   { name: '底图',       icon: '🖼️', desc: '关卡背景底图',              accept: 'JPG/PNG' },
  'source':       { name: '工程文件',   icon: '📐', desc: 'PSD/Spine 可编辑源文件',    accept: 'PSD/PSB/SPINE/AI' },
  'spine_export': { name: '动画导出',   icon: '📦', desc: 'Spine 导出三件套',          accept: 'atlas/json/png' },
  'cutout':       { name: '切图素材',   icon: '✂️', desc: '给程序/Spine用的散图',      accept: 'PNG' },
  'icon_set':     { name: '收集栏图标', icon: '🏅', desc: 'icon_001 ~ xxx 系列',       accept: 'PNG' },
  'package':      { name: '打包交付',   icon: '📮', desc: '给程序的压缩包',            accept: 'ZIP/RAR/7Z' },
  'unknown':      { name: '未分类',     icon: '❓', desc: '尚未识别的文件',            accept: '—' },
};

// 过程文件卡片（折叠抽屉内）
const ARCHIVE_PROCESS_CATS = {
  'process_ai':    { name: '过程-AI生图',   icon: '🤖', desc: '即梦 / MJ / SD 生成',        accept: 'JPG/PNG' },
  'process_ref':   { name: '过程-参考截图', icon: '📸', desc: '企微截图 / 屏幕截图',        accept: 'JPG/PNG' },
  'process_draft': { name: '过程-草稿迭代', icon: '📝', desc: 'UUID / 带版本号的迭代稿',    accept: 'JPG/PNG/PSD' },
};

const IMG_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

function switchToQuickArchive() {
  const root = document.getElementById('organizeRoot').value.trim();
  if (!root) {
    showToast('请先选择或输入项目目录', 'warning');
    return;
  }

  document.getElementById('organizeSummary').classList.add('hidden');
  document.getElementById('organizeBody').classList.add('hidden');
  document.getElementById('organizeFooter').classList.add('hidden');
  document.getElementById('quickArchiveView').classList.remove('hidden');

  scanArchiveFiles(root);
}

function switchToOrganizeMode() {
  document.getElementById('quickArchiveView').classList.add('hidden');
  document.getElementById('organizeSummary').classList.remove('hidden');
  document.getElementById('organizeBody').classList.remove('hidden');
  document.getElementById('organizeFooter').classList.remove('hidden');
}

async function scanArchiveFiles(root) {
  try {
    showToast('正在扫描目录...', 'info');
    const resp = await fetch('/api/organize/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root })
    });
    if (!resp.ok) throw new Error('扫描失败');
    const data = await resp.json();
    archiveData = data;

    // 铺平文件列表
    archiveFiles = [];
    for (const [catId, files] of Object.entries(data.categories || {})) {
      for (const f of files) {
        archiveFiles.push({
          ...f,
          category: catId,
          archiveCategory: catId, // 初始=规则判定结果
          ai_classified: false,
          ai_reason: '',
          ai_content: '',
        });
      }
    }

    // 填充项目/模块输入框（优先用后端扫描返回，若为空则用目录名）
    const pathParts = (root || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    const guessModule  = pathParts[pathParts.length - 1] || '';
    const guessProject = pathParts[pathParts.length - 2] || '';
    const projInput = document.getElementById('archiveProjectNameInput');
    const modInput  = document.getElementById('archiveModuleNameInput');
    if (projInput && !projInput.value) projInput.value = data.project_name || guessProject;
    if (modInput  && !modInput.value)  modInput.value  = data.level_name   || guessModule;

    document.getElementById('archiveFileCount').textContent = `共 ${archiveFiles.length} 个文件`;

    // 自动触发项目识别（后台静默）
    autoDetectProjectForArchive();

    renderArchiveCards();
  } catch (e) {
    showToast(`扫描失败: ${e.message}`, 'error');
  }
}

async function autoDetectProjectForArchive() {
  if (!archiveData || !archiveData.root) return;
  try {
    const resp = await fetch('/api/organize/detect_project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: archiveData.root })
    });
    if (!resp.ok) return;
    const r = await resp.json();
    if (!r.ok) return;

    const projInput = document.getElementById('archiveProjectNameInput');
    const modInput  = document.getElementById('archiveModuleNameInput');
    const typeSel   = document.getElementById('archiveModuleTypeSelect');
    const confEl    = document.getElementById('archiveConfidence');
    const reasonEl  = document.getElementById('archiveReasoning');

    if (r.project_name && projInput && !projInput.dataset.userEdited) {
      projInput.value = r.project_name;
    }
    const modName = r.module_name || r.level_name;
    if (modName && modInput && !modInput.dataset.userEdited) {
      modInput.value = modName;
    }
    if (r.module_type && typeSel) {
      const valid = ['level', 'home', 'common_ui', 'loading', 'other'];
      typeSel.value = valid.includes(r.module_type) ? r.module_type : 'level';
    }
    if (confEl && r.confidence) {
      confEl.className = `archive-confidence ${r.confidence}`;
      confEl.textContent = `🎯 ${({high:'高置信',medium:'中置信',low:'低置信'})[r.confidence] || r.confidence}`;
    }
    if (reasonEl && r.reasoning) {
      reasonEl.textContent = `💡 ${r.reasoning}`;
    }
  } catch (e) {
    console.warn('[archive] 项目识别失败', e);
  }
}

// 标记用户手动编辑过输入框，避免被自动识别覆盖
['archiveProjectNameInput', 'archiveModuleNameInput'].forEach(id => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { el.dataset.userEdited = '1'; });
  });
});

// ==== 渲染看板 ====
function renderArchiveCards() {
  if (!archiveData) return;

  // 主卡片
  const mainGrid = document.getElementById('archiveCardsGrid');
  mainGrid.innerHTML = Object.entries(ARCHIVE_MAIN_CATS)
    .map(([cid, info]) => renderArchiveCard(cid, info))
    .join('');

  // 过程文件抽屉
  const drawer = document.getElementById('archiveProcessDrawer');
  const processTotal = archiveFiles.filter(f =>
    Object.prototype.hasOwnProperty.call(ARCHIVE_PROCESS_CATS, f.archiveCategory)
  ).length;

  drawer.innerHTML = `
    <div class="archive-drawer-header" onclick="toggleArchiveProcessDrawer()">
      <span class="archive-drawer-chevron ${archiveProcessDrawerOpen ? 'rotated' : ''}">▶</span>
      <span class="archive-drawer-title">🗂 过程文件（默认折叠）</span>
      <span class="archive-drawer-count">${processTotal} 项</span>
    </div>
    <div class="archive-drawer-body ${archiveProcessDrawerOpen ? '' : 'hidden'}">
      ${Object.entries(ARCHIVE_PROCESS_CATS).map(([cid, info]) => renderArchiveCard(cid, info)).join('')}
    </div>
  `;

  // 绑定拖拽事件
  bindArchiveDragEvents();
}

function renderArchiveCard(catId, info) {
  const filesInCat = archiveFiles.filter(f => f.archiveCategory === catId);
  const count = filesInCat.length;
  const isImgHeavy = filesInCat.some(f => !f.is_dir && IMG_EXT_RE.test(f.name));

  const bodyHtml = count === 0
    ? `<div class="archive-card-empty">拖拽文件到此处</div>`
    : `<div class="archive-card-files ${isImgHeavy ? '' : 'text-layout'}">
         ${filesInCat.map(f => renderArchiveFileItem(f)).join('')}
       </div>`;

  return `
    <div class="archive-card" data-category="${catId}">
      <div class="archive-card-header">
        <div class="archive-card-title">
          <span class="archive-card-icon">${info.icon}</span>
          <span class="archive-card-name">${info.name}</span>
          <span class="archive-card-count ${count === 0 ? 'empty' : ''}">${count}</span>
        </div>
        <span class="archive-card-accept" title="${info.desc}">${info.accept}</span>
      </div>
      <div class="archive-card-desc">${info.desc}</div>
      ${bodyHtml}
    </div>
  `;
}

function renderArchiveFileItem(f) {
  const isImg = !f.is_dir && IMG_EXT_RE.test(f.name);
  const pathAttr = encodeURIComponent(f.path);
  const aiBadge = f.ai_classified
    ? `<span class="${isImg ? 'tile-ai' : 'row-ai'}" title="AI ${f.ai_source === 'llm_vision' ? '识图' : '识别'}: ${escapeHtml(f.ai_reason || '')}${f.ai_content ? ' · ' + escapeHtml(f.ai_content) : ''}">🤖</span>`
    : '';

  if (isImg) {
    const thumbUrl = `/api/thumb?path=${pathAttr}&size=128`;
    const contentTip = f.ai_content
      ? `<span class="tile-content" title="${escapeHtml(f.ai_content)}">${escapeHtml(f.ai_content)}</span>`
      : '';
    return `
      <div class="archive-file-tile" draggable="true" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.name)}${f.ai_reason ? '\n🤖 ' + f.ai_reason : ''}">
        <img src="${thumbUrl}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'tile-fallback\\'>🖼️</div>'">
        ${aiBadge}
        ${contentTip}
        <span class="tile-name">${escapeHtml(f.name)}</span>
      </div>
    `;
  }

  const icon = f.is_dir ? '📁' : iconForExt(f.name);
  return `
    <div class="archive-file-row" draggable="true" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.name)}${f.ai_reason ? '\n🤖 ' + f.ai_reason : ''}">
      <span class="row-icon">${icon}</span>
      <span class="row-name">${escapeHtml(f.name)}</span>
      ${aiBadge}
      <span class="row-size">${f.size_human || ''}</span>
    </div>
  `;
}

function iconForExt(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['psd', 'psb', 'ai', 'sketch', 'xd', 'fig'].includes(ext)) return '🎨';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))          return '📦';
  if (['atlas', 'json', 'skel'].includes(ext))                  return '🦴';
  if (['mp4', 'mov', 'webm', 'avi'].includes(ext))              return '🎞️';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext))               return '🎵';
  if (['txt', 'md', 'log'].includes(ext))                       return '📄';
  return '📄';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toggleArchiveProcessDrawer() {
  archiveProcessDrawerOpen = !archiveProcessDrawerOpen;
  renderArchiveCards();
}

// ==== 拖拽 ====
function bindArchiveDragEvents() {
  document.querySelectorAll('.archive-card').forEach(card => {
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetCat = card.dataset.category;
      const filePath = e.dataTransfer.getData('text/plain');
      if (!filePath || !targetCat) return;
      const idx = archiveFiles.findIndex(f => f.path === filePath);
      if (idx === -1) return;
      if (archiveFiles[idx].archiveCategory === targetCat) return;
      archiveFiles[idx].archiveCategory = targetCat;
      // 手动移动，清除 AI 标记
      archiveFiles[idx].ai_classified = false;
      renderArchiveCards();
    });
  });

  document.querySelectorAll('.archive-file-tile, .archive-file-row').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.setData('text/plain', el.dataset.path);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
}

// ==== AI 辅助分类（识图 + OCR）====
async function archiveClassifyAll() {
  if (!archiveData) {
    showToast('请先扫描目录', 'warning');
    return;
  }
  // 找出所有 unknown 的文件（包括初始就 unknown 的，以及用户拖回 unknown 的）
  const unknownFiles = archiveFiles.filter(f => f.archiveCategory === 'unknown');
  if (unknownFiles.length === 0) {
    showToast('暂无需要 AI 分类的文件', 'info');
    return;
  }

  const btn = document.getElementById('archiveAIBtn');
  if (btn) {
    btn.classList.add('loading');
    btn.disabled = true;
    btn.textContent = '🤖 AI 识图中...';
  }

  try {
    const resp = await fetch('/api/organize/llm_classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: archiveData.root,
        files: unknownFiles.map(f => ({
          name: f.name, path: f.path, size_human: f.size_human, is_dir: f.is_dir
        }))
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'AI 分类失败');

    let applied = 0;
    for (const r of (result.results || [])) {
      const idx = archiveFiles.findIndex(f => f.name === r.name && f.archiveCategory === 'unknown');
      if (idx !== -1 && r.category && r.category !== 'unknown') {
        archiveFiles[idx].archiveCategory = r.category;
        archiveFiles[idx].ai_classified  = true;
        archiveFiles[idx].ai_reason      = r.reason || '';
        archiveFiles[idx].ai_content     = r.content || '';
        archiveFiles[idx].ai_source      = r.source  || '';
        applied++;
      }
    }
    renderArchiveCards();
    showToast(`AI 已分类 ${applied} / ${unknownFiles.length} 个文件`, 'success');
  } catch (e) {
    showToast(`AI 分类失败: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = '🤖 AI辅助识图分类';
    }
  }
}

// ==== 执行归档 ====
async function executeArchive() {
  if (!archiveData || archiveFiles.length === 0) {
    showToast('没有可归档的文件', 'warning');
    return;
  }
  const projectName = (document.getElementById('archiveProjectNameInput')?.value || '').trim();
  const moduleName  = (document.getElementById('archiveModuleNameInput')?.value  || '').trim();
  if (!projectName || !moduleName) {
    showToast('请先填写项目名和模块名', 'warning');
    return;
  }

  const moves = [];
  for (const f of archiveFiles) {
    if (f.archiveCategory && f.archiveCategory !== 'unknown') {
      moves.push({ path: f.path, category: f.archiveCategory });
    }
  }
  if (moves.length === 0) {
    showToast('没有需要移动的文件（全部是 unknown）', 'warning');
    return;
  }

  const skipped = archiveFiles.length - moves.length;
  const confirmMsg = `将归档 ${moves.length} 个文件到：\n  <项目根>\\_分类\\${projectName}_${moduleName}\\\n${skipped > 0 ? `\n⚠ ${skipped} 个 unknown 文件不会被移动` : ''}\n\n确定执行吗？`;
  if (!confirm(confirmMsg)) return;

  // 父目录作为 root（分类目录和 <项目>_<模块> 子目录都在这个父目录下）
  const parentRoot = archiveData.root.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');

  try {
    const resp = await fetch('/api/organize/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: parentRoot,
        project_name: projectName,
        module_name: moduleName,
        level_name: moduleName, // 向后兼容
        moves: moves
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    if (result.error) {
      showToast(`归档失败: ${result.error}`, 'error');
      return;
    }
    showToast(`✅ 成功归档 ${result.moved || 0} 个文件${result.failed ? `，${result.failed} 个失败` : ''}`, 'success');
    // 归档成功后重新扫描
    scanArchiveFiles(archiveData.root);
  } catch (e) {
    showToast(`归档失败: ${e.message}`, 'error');
  }
}

/* ======================================================================
 * 🎮 游戏项目工作台（Step 1：项目切换器 + 工作台框架）
 * ====================================================================== */

// 全局 showToast 兜底：代理到 lingxi.showToast，让类外的独立函数也能用
if (typeof window.showToast !== 'function') {
  window.showToast = function(msg, type) {
    if (window.lingxi && typeof lingxi.showToast === 'function') {
      lingxi.showToast(msg, type);
    } else {
      console.log('[toast]', type || 'info', msg);
    }
  };
}

let projectsState = {
  list: [],              // 项目列表 [{id, name, path, type, status, createdAt}]
  currentId: null,       // 当前选中的项目 id
  editingId: null        // 正在编辑的项目 id（null 表示新增）
};

const PROJECT_TYPE_LABEL = {
  zhaocha: '找茬',
  pintu:   '拼图',
  other:   '其他'
};
const PROJECT_STATUS_LABEL = {
  dev:      '开发中',
  test:     '测试中',
  online:   '已上线',
  archived: '已归档'
};
const PROJECT_STATUS_COLOR = {
  dev:      '#00b894',
  test:     '#fdcb6e',
  online:   '#74b9ff',
  archived: '#8a8aa8'
};

function _projUid() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- 初始化：页面加载后从 config 拉项目列表 ----
async function loadProjectsFromConfig() {
  try {
    // 等待 lingxi 初始化完毕（loadConfig 是 init 里第一步）
    let retry = 0;
    while ((!lingxi || !lingxi.config) && retry < 50) {
      await new Promise(r => setTimeout(r, 100));
      retry++;
    }
    const cfg = (lingxi && lingxi.config) || {};
    projectsState.list = Array.isArray(cfg.projects) ? cfg.projects : [];
    // 恢复上次选中的项目
    const lastId = localStorage.getItem('lingxi.currentProjectId');
    if (lastId && projectsState.list.some(p => p.id === lastId)) {
      projectsState.currentId = lastId;
    } else if (projectsState.list.length > 0) {
      projectsState.currentId = projectsState.list[0].id;
    }
    renderProjectSwitcher();
    renderWorkbenchView();
    if (typeof renderGameLibrary === 'function') renderGameLibrary();
  } catch (e) {
    console.error('加载项目列表失败:', e);
  }
}

async function saveProjectsToConfig() {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: projectsState.list })
    });
    if (lingxi) lingxi.config.projects = projectsState.list;
  } catch (e) {
    console.error('保存项目列表失败:', e);
    showToast('保存项目列表失败', 'error');
  }
}

function _getCurrentProject() {
  if (!projectsState.currentId) return null;
  return projectsState.list.find(p => p.id === projectsState.currentId) || null;
}

function _escHtml(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// ---- 渲染：项目切换器 ----
function renderProjectSwitcher() {
  const cur = _getCurrentProject();
  const nameEl = document.getElementById('projectName');
  const statusEl = document.getElementById('projectStatus');
  const tagEl = document.getElementById('projectTypeTag');
  const avatarEl = document.getElementById('projectAvatar');
  if (!nameEl) return;

  if (cur) {
    nameEl.textContent = cur.name;
    statusEl.innerHTML = `
      <span class="project-status-dot" style="background:${PROJECT_STATUS_COLOR[cur.status] || '#8a8aa8'}"></span>
      ${_escHtml(PROJECT_STATUS_LABEL[cur.status] || cur.status || '')}
    `;
    tagEl.textContent = PROJECT_TYPE_LABEL[cur.type] || cur.type || '';
    tagEl.classList.remove('hidden');
    avatarEl.textContent = (cur.name || '🎮').slice(0, 1);
  } else {
    nameEl.textContent = '选择游戏项目';
    statusEl.textContent = '点击添加或切换';
    tagEl.classList.add('hidden');
    avatarEl.textContent = '🎮';
  }

  // 菜单列表
  const menuList = document.getElementById('projectMenuList');
  if (menuList) {
    if (projectsState.list.length === 0) {
      menuList.innerHTML = '<div class="project-menu-empty">暂无项目，点击下方按钮添加</div>';
    } else {
      menuList.innerHTML = projectsState.list.map(p => `
        <div class="project-menu-item ${p.id === projectsState.currentId ? 'active' : ''}"
             onclick="switchProject('${p.id}')" title="${_escHtml(p.path)}">
          <div class="project-menu-avatar">${_escHtml((p.name || '🎮').slice(0, 1))}</div>
          <div class="project-menu-info">
            <div class="project-menu-name">
              ${_escHtml(p.name)}
              <span class="project-type-tag">${_escHtml(PROJECT_TYPE_LABEL[p.type] || '')}</span>
            </div>
            <div class="project-menu-status">
              <span class="project-status-dot" style="background:${PROJECT_STATUS_COLOR[p.status] || '#8a8aa8'}"></span>
              ${_escHtml(PROJECT_STATUS_LABEL[p.status] || '')}
            </div>
          </div>
        </div>
      `).join('');
    }
  }

  // 工作台 Tab 计数提示
  const hint = document.getElementById('workbenchTabHint');
  if (hint) {
    hint.textContent = projectsState.list.length > 0 ? `(${projectsState.list.length})` : '';
  }
}

function renderWorkbenchView() {
  const emptyEl = document.getElementById('workbenchEmpty');
  const contentEl = document.getElementById('workbenchContent');
  if (!emptyEl || !contentEl) return;

  const cur = _getCurrentProject();
  if (!cur) {
    emptyEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  contentEl.classList.remove('hidden');

  // 顶部项目信息
  const nameEl   = document.getElementById('wbProjectName');
  const typeEl   = document.getElementById('wbProjectType');
  const statusEl = document.getElementById('wbProjectStatus');
  const pathEl   = document.getElementById('wbProjectPath');
  if (nameEl)   nameEl.textContent = cur.name;
  if (typeEl) {
    typeEl.textContent = PROJECT_TYPE_LABEL[cur.type] || cur.type || '';
  }
  if (statusEl) {
    statusEl.innerHTML = `
      <span class="project-status-dot" style="background:${PROJECT_STATUS_COLOR[cur.status] || '#8a8aa8'}"></span>
      ${_escHtml(PROJECT_STATUS_LABEL[cur.status] || '')}
    `;
  }
  if (pathEl) pathEl.textContent = cur.path;

  // 切到不同项目时，清空选中模块
  if (wbState.lastProjectId !== cur.id) {
    wbState.lastProjectId = cur.id;
    wbState.currentModulePath = null;
    wbState.scanResult = null;
    wbState.moduleScanCache = {};
    scanProjectModules();
  }
}

// ---- 项目菜单：打开/关闭 ----
function toggleProjectMenu() {
  const menu = document.getElementById('projectMenu');
  if (!menu) return;
  const open = !menu.classList.contains('hidden');
  if (open) {
    menu.classList.add('hidden');
  } else {
    menu.classList.remove('hidden');
    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', _closeProjectMenuOnOutside, { once: true });
    }, 0);
  }
}
function _closeProjectMenuOnOutside(e) {
  const sw = document.getElementById('projectSwitcher');
  if (sw && !sw.contains(e.target)) {
    document.getElementById('projectMenu').classList.add('hidden');
  } else {
    // 点在 switcher 内部，下次再监听
    document.addEventListener('click', _closeProjectMenuOnOutside, { once: true });
  }
}

function closeProjectMenu() {
  const menu = document.getElementById('projectMenu');
  if (menu) menu.classList.add('hidden');
}

// ---- 切换项目 ----
function switchProject(id) {
  const proj = projectsState.list.find(p => p.id === id);
  if (!proj) return;
  projectsState.currentId = id;
  localStorage.setItem('lingxi.currentProjectId', id);
  // 🎮 自动展开游戏库里对应卡片
  if (typeof glState !== 'undefined') glState.expandedId = id;
  closeProjectMenu();
  renderProjectSwitcher();
  renderWorkbenchView();
  if (typeof renderGameLibrary === 'function') renderGameLibrary();
  // 自动切到工作台视图
  switchMainView('workbench');
  showToast(`已切换到「${proj.name}」`, 'success');
}

// ---- 主视图切换（工作台-only 模式：仅保留工作台） ----
function switchMainView(view) {
  const workbenchView = document.getElementById('workbenchView');
  if (!workbenchView) return;
  // 无论参数如何，都只展示工作台
  workbenchView.classList.remove('hidden');
  renderWorkbenchView();
}

// ---- 添加/编辑项目弹窗 ----
function openAddProject(editId) {
  closeProjectMenu();
  projectsState.editingId = editId || null;
  const modal = document.getElementById('addProjectModal');
  const title = document.getElementById('addProjectTitle');
  const pathIn = document.getElementById('projPath');
  const nameIn = document.getElementById('projName');
  const typeIn = document.getElementById('projType');
  const statusIn = document.getElementById('projStatus');

  if (editId) {
    const p = projectsState.list.find(x => x.id === editId);
    if (!p) return;
    title.textContent = '✏️ 编辑游戏项目';
    pathIn.value = p.path || '';
    nameIn.value = p.name || '';
    typeIn.value = p.type || 'zhaocha';
    statusIn.value = p.status || 'dev';
  } else {
    title.textContent = '➕ 添加游戏项目';
    pathIn.value = '';
    nameIn.value = '';
    typeIn.value = 'zhaocha';
    statusIn.value = 'dev';
  }
  modal.classList.remove('hidden');
  setTimeout(() => pathIn.focus(), 50);

  // 非编辑态：清空旧候选列表并默认不自动扫描（按钮一下触发）
  if (!editId) {
    const body = document.getElementById('autoDiscoverBody');
    if (body) {
      body.classList.add('hidden');
      body.innerHTML = '';
    }
  } else {
    // 编辑态：隐藏自动发现区域
    const sec = document.getElementById('autoDiscoverSection');
    if (sec) sec.classList.add('hidden');
  }
}

function closeAddProject() {
  document.getElementById('addProjectModal').classList.add('hidden');
  projectsState.editingId = null;
  // 下次打开前，确保自动发现区域可见（编辑态会隐藏）
  const sec = document.getElementById('autoDiscoverSection');
  if (sec) sec.classList.remove('hidden');
}

// ---- 🔍 自动发现游戏项目 ----
async function runAutoDiscover() {
  const btn = document.getElementById('autoDiscoverBtn');
  const body = document.getElementById('autoDiscoverBody');
  if (!body) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 扫描中...';
  }
  body.classList.remove('hidden');
  body.innerHTML = '<div class="discover-loading">正在扫描所有驱动器，识别游戏项目...</div>';
  try {
    const resp = await fetch('/api/project/auto_discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderDiscoverCandidates(data.candidates || []);
  } catch (e) {
    body.innerHTML = `<div class="discover-error">❌ 扫描失败：${_escHtml(e.message)}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔎 重新扫描';
    }
  }
}

function renderDiscoverCandidates(candidates) {
  const body = document.getElementById('autoDiscoverBody');
  if (!body) return;
  if (!candidates.length) {
    body.innerHTML = `
      <div class="discover-empty">
        <p>📭 没有发现符合特征的游戏项目目录</p>
        <p class="hint-muted">可以在下方手动填写路径添加</p>
      </div>
    `;
    return;
  }

  const unaddedCount = candidates.filter(c => !c.already_added).length;
  const TYPE_LABELS = { zhaocha: '找茬', pintu: '拼图', other: '其他' };

  body.innerHTML = `
    <div class="discover-stats">
      <span>发现 <strong>${candidates.length}</strong> 个候选项目${unaddedCount > 0 ? `，其中 <strong class="accent">${unaddedCount}</strong> 个未添加` : ''}</span>
      ${unaddedCount > 1 ? `<button class="btn-sm btn-mini-primary" onclick="addAllDiscoveredProjects()">✨ 一键添加全部</button>` : ''}
    </div>
    <div class="discover-list">
      ${candidates.map((c, i) => `
        <div class="discover-item ${c.already_added ? 'added' : ''}" data-idx="${i}">
          <div class="discover-icon">${c.suggested_type === 'zhaocha' ? '🔍' : c.suggested_type === 'pintu' ? '🧩' : '🎮'}</div>
          <div class="discover-info">
            <div class="discover-name-row">
              <span class="discover-name">${_escHtml(c.name)}</span>
              <span class="discover-type-tag">${TYPE_LABELS[c.suggested_type] || c.suggested_type}</span>
              <span class="discover-score" title="识别可信度">${'★'.repeat(Math.min(c.score, 5))}</span>
            </div>
            <div class="discover-path" title="${_escHtml(c.path)}">${_escHtml(c.path)}</div>
            <div class="discover-meta">
              ${c.level_like_count > 0 ? `🎯 ${c.level_like_count} 个关卡` : ''}
              ${c.subdir_count ? `· 📁 ${c.subdir_count} 个子目录` : ''}
              · ${_escHtml((c.reasons || []).join(' / '))}
            </div>
          </div>
          <div class="discover-action">
            ${c.already_added
              ? '<span class="discover-added-tag">✓ 已添加</span>'
              : `<button class="btn-sm btn-mini-primary" onclick="addDiscoveredProject(${i})">➕ 添加</button>`
            }
          </div>
        </div>
      `).join('')}
    </div>
  `;

  // 把候选数据挂到 body 上供按钮读取
  body.__candidates = candidates;
}

async function addDiscoveredProject(idx) {
  const body = document.getElementById('autoDiscoverBody');
  const cands = body && body.__candidates;
  if (!cands || !cands[idx]) return;
  const c = cands[idx];

  const proj = {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: c.name,
    path: c.path,
    type: c.suggested_type || 'other',
    status: 'dev',
    created_at: new Date().toISOString(),
  };
  projectsState.list.push(proj);
  // 如果当前没有选中项目，自动选中
  if (!projectsState.currentId) {
    projectsState.currentId = proj.id;
    localStorage.setItem('lingxi.currentProjectId', proj.id);
  }
  try {
    await saveProjectsToConfig();
    renderProjectSwitcher();
    // 标记为已添加
    cands[idx].already_added = true;
    renderDiscoverCandidates(cands);
    showToast(`✓ 已添加「${proj.name}」`, 'success');
    // 如果是第一次添加，切到工作台
    if (projectsState.list.length === 1) {
      setTimeout(() => {
        closeAddProject();
        switchMainView('workbench');
      }, 400);
    }
  } catch (e) {
    // 回滚
    projectsState.list = projectsState.list.filter(p => p.id !== proj.id);
    showToast(`添加失败：${e.message}`, 'error');
  }
}

async function addAllDiscoveredProjects() {
  const body = document.getElementById('autoDiscoverBody');
  const cands = body && body.__candidates;
  if (!cands) return;
  const todo = cands.map((c, i) => ({ c, i })).filter(x => !x.c.already_added);
  if (!todo.length) {
    showToast('所有候选项目都已添加', 'info');
    return;
  }
  const backup = [...projectsState.list];
  let added = 0;
  for (const { c, i } of todo) {
    const proj = {
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_' + i,
      name: c.name,
      path: c.path,
      type: c.suggested_type || 'other',
      status: 'dev',
      created_at: new Date().toISOString(),
    };
    projectsState.list.push(proj);
    cands[i].already_added = true;
    added++;
  }
  // 自动选中第一个
  if (!projectsState.currentId && projectsState.list.length > 0) {
    projectsState.currentId = projectsState.list[0].id;
    localStorage.setItem('lingxi.currentProjectId', projectsState.currentId);
  }
  try {
    await saveProjectsToConfig();
    renderProjectSwitcher();
    renderDiscoverCandidates(cands);
    showToast(`✓ 一键添加了 ${added} 个项目`, 'success');
    setTimeout(() => {
      closeAddProject();
      switchMainView('workbench');
    }, 500);
  } catch (e) {
    projectsState.list = backup;
    renderProjectSwitcher();
    showToast(`批量添加失败：${e.message}`, 'error');
  }
}

function pickProjectPath() {
  if (!lingxi) return;
  lingxi.pickDirectory('选择游戏项目根目录').then(path => {
    if (!path) return;
    const pathIn = document.getElementById('projPath');
    const nameIn = document.getElementById('projName');
    if (pathIn) pathIn.value = path;
    // 自动用文件夹名填充项目名（若为空）
    if (nameIn && !nameIn.value.trim()) {
      const folderName = path.split(/[\\/]/).filter(Boolean).pop() || '';
      // 清理常见后缀：（游戏项目）、(游戏项目)、_项目 等
      const cleaned = folderName
        .replace(/[（(][^）)]*[）)]\s*$/, '')
        .replace(/[_\-]?(项目|素材|game|project)\s*$/i, '')
        .trim() || folderName;
      nameIn.value = cleaned;
    }
  });
}

async function confirmAddProject() {
  const path = document.getElementById('projPath').value.trim();
  const name = document.getElementById('projName').value.trim();
  const type = document.getElementById('projType').value;
  const status = document.getElementById('projStatus').value;

  if (!path) { showToast('请选择项目根目录', 'warning'); return; }
  if (!name) { showToast('请输入项目名称', 'warning'); return; }

  // 重复检查
  const dupByPath = projectsState.list.find(p =>
    p.path === path && p.id !== projectsState.editingId
  );
  if (dupByPath) {
    showToast(`该目录已被项目「${dupByPath.name}」使用`, 'warning');
    return;
  }

  if (projectsState.editingId) {
    // 编辑
    const idx = projectsState.list.findIndex(p => p.id === projectsState.editingId);
    if (idx !== -1) {
      projectsState.list[idx] = {
        ...projectsState.list[idx],
        name, path, type, status,
        updatedAt: Date.now()
      };
    }
  } else {
    // 新增
    const newProj = {
      id: _projUid(),
      name, path, type, status,
      createdAt: Date.now()
    };
    projectsState.list.push(newProj);
    projectsState.currentId = newProj.id;
    localStorage.setItem('lingxi.currentProjectId', newProj.id);
  }

  await saveProjectsToConfig();
  closeAddProject();
  renderProjectSwitcher();
  renderWorkbenchView();
  showToast(projectsState.editingId ? '✓ 项目已更新' : '✓ 项目已添加', 'success');
}

// ---- 管理项目弹窗 ----
function openManageProjects() {
  closeProjectMenu();
  renderManageProjects();
  document.getElementById('manageProjectsModal').classList.remove('hidden');
}
function closeManageProjects() {
  document.getElementById('manageProjectsModal').classList.add('hidden');
}
function renderManageProjects() {
  const body = document.getElementById('manageProjectsBody');
  if (!body) return;
  if (projectsState.list.length === 0) {
    body.innerHTML = '<div class="ai-empty">暂无项目，点击下方按钮添加第一个</div>';
    return;
  }
  body.innerHTML = projectsState.list.map(p => `
    <div class="manage-project-row">
      <div class="manage-project-avatar">${_escHtml((p.name || '🎮').slice(0, 1))}</div>
      <div class="manage-project-info">
        <div class="manage-project-name">
          ${_escHtml(p.name)}
          <span class="project-type-tag">${_escHtml(PROJECT_TYPE_LABEL[p.type] || '')}</span>
          <span class="project-status-mini">
            <span class="project-status-dot" style="background:${PROJECT_STATUS_COLOR[p.status] || '#8a8aa8'}"></span>
            ${_escHtml(PROJECT_STATUS_LABEL[p.status] || '')}
          </span>
        </div>
        <div class="manage-project-path" title="${_escHtml(p.path)}">${_escHtml(p.path)}</div>
      </div>
      <div class="manage-project-actions">
        <button class="btn-sm" onclick="openAddProject('${p.id}')">✏️ 编辑</button>
        <button class="btn-sm danger" onclick="removeProject('${p.id}')">🗑 移除</button>
      </div>
    </div>
  `).join('');
}

async function removeProject(id) {
  const p = projectsState.list.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`确定移除项目「${p.name}」吗？\n（仅从列表移除，不会删除任何实际文件）`)) return;
  projectsState.list = projectsState.list.filter(x => x.id !== id);
  if (projectsState.currentId === id) {
    projectsState.currentId = projectsState.list[0]?.id || null;
    if (projectsState.currentId) {
      localStorage.setItem('lingxi.currentProjectId', projectsState.currentId);
    } else {
      localStorage.removeItem('lingxi.currentProjectId');
    }
  }
  await saveProjectsToConfig();
  renderProjectSwitcher();
  renderWorkbenchView();
  renderManageProjects();
  showToast('项目已移除', 'success');
}

/* ---- Step 2: 工作台看板核心逻辑 ---- */

let wbState = {
  lastProjectId: null,     // 上一次 render 时的项目 ID（切项目自动触发重扫）
  scanResult: null,        // /api/project/scan 返回：{levels, common_modules, ...}
  currentModulePath: null, // 选中的关卡/模块路径
  moduleScanCache: {},     // 模块详细分类扫描缓存 { [modulePath]: {categories,stats,...} }
  scanning: false,
  boardLoading: false,
};

// 归档分类的展示顺序（与截图风格一致，过程文件默认折叠）
const WB_BOARD_ORDER = [
  'completion', 'source', 'spine_export', 'cutout',
  'icon_set', 'package',
];
const WB_PROCESS_CATS = ['process_ai', 'process_ref', 'process_draft'];

const MODULE_TYPE_LABEL = {
  level: '关卡',
  home: '主页',
  common_ui: '通用UI',
  loading: '加载页',
  other: '其他',
};

const MODULE_TYPE_ICON = {
  level: '🎯',
  home: '🏠',
  common_ui: '🧩',
  loading: '⏳',
  other: '📁',
};

function _pct(v) {
  return Math.round((v || 0) * 100) + '%';
}

async function scanProjectModules() {
  const cur = _getCurrentProject();
  if (!cur) return;
  if (wbState.scanning) return;
  wbState.scanning = true;

  const sidebar = document.getElementById('wbSidebar');
  if (sidebar) {
    sidebar.innerHTML = '<div class="wb-loading">⏳ 正在扫描项目结构...</div>';
  }

  try {
    const resp = await fetch('/api/project/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: cur.path })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    wbState.scanResult = data;
    renderModuleList();
    renderOverallProgress();
    // 🎮 新游戏库：缓存扫描结果并刷新卡片+关卡
    if (typeof glState !== 'undefined') {
      glState.projectScans[cur.id] = data;
      if (typeof renderGameLibrary === 'function') renderGameLibrary();
      if (typeof renderGameLevels === 'function') renderGameLevels(cur.id);
    }

    // 自动选中第一个有内容的关卡（优先关卡，其次通用模块）
    const firstLevel = (data.levels || [])[0];
    const firstCommon = (data.common_modules || [])[0];
    const target = firstLevel || firstCommon;
    if (target && !wbState.currentModulePath) {
      selectModule(target.path);
    }
  } catch (e) {
    if (sidebar) {
      sidebar.innerHTML = `<div class="wb-error">❌ 扫描失败：${_escHtml(e.message)}</div>`;
    }
    showToast(`扫描项目失败：${e.message}`, 'error');
  } finally {
    wbState.scanning = false;
  }
}

function renderOverallProgress() {
  const sr = wbState.scanResult;
  if (!sr) return;
  const all = [...(sr.levels || []), ...(sr.common_modules || [])];
  const total = all.length;
  // 定义"已归档"= progress >= 0.5（至少完成一半分类）
  const done = all.filter(m => (m.progress || 0) >= 0.5).length;
  const pct = total > 0 ? (done / total) : 0;

  const pctEl  = document.getElementById('wbOverallPct');
  const fillEl = document.getElementById('wbOverallFill');
  const metaEl = document.getElementById('wbOverallMeta');
  if (pctEl)  pctEl.textContent  = _pct(pct);
  if (fillEl) fillEl.style.width = _pct(pct);
  if (metaEl) metaEl.textContent = `${done} / ${total} 个模块已归档（过半分类完成）`;
}

function renderModuleList() {
  const sidebar = document.getElementById('wbSidebar');
  if (!sidebar) return;
  const sr = wbState.scanResult;
  if (!sr) return;

  const levels = sr.levels || [];
  const commons = sr.common_modules || [];
  const looseFiles = sr.loose_files || [];

  // --- 空状态：也要能新建关卡 ---
  if (levels.length === 0 && commons.length === 0) {
    sidebar.innerHTML = `
      <div class="wb-empty-sidebar">
        <div class="wb-empty-icon">📂</div>
        <p>项目根目录下还没有关卡</p>
        <p class="hint-muted">可以用龙虾整理，或在这里直接创建</p>
        <button class="wb-btn-create-level" onclick="createNewLevel()">➕ 新建关卡</button>
        <button class="wb-btn-sm" style="margin-top:8px" onclick="createNewModule('home')">✨ 新建主页特效</button>
      </div>
      ${renderLooseFilesBlock(looseFiles)}
    `;
    return;
  }

  const renderModuleItem = (m) => {
    const isActive = m.path === wbState.currentModulePath;
    const pct = _pct(m.progress);
    const archCount = (m.archived_categories || []).length;
    const totalCats = m.total_categories || 0;
    const fileCount = m.file_count || 0;
    return `
      <div class="wb-module-item ${isActive ? 'active' : ''}"
           data-path="${_escHtml(m.path)}"
           title="${_escHtml(m.path)}">
        <div class="wb-module-icon">${MODULE_TYPE_ICON[m.module_type] || '📁'}</div>
        <div class="wb-module-info">
          <div class="wb-module-name">
            ${_escHtml(m.name)}
            ${m.module_type !== 'level' ? `<span class="wb-module-tag">${_escHtml(MODULE_TYPE_LABEL[m.module_type] || '')}</span>` : ''}
          </div>
          <div class="wb-module-meta">
            <span class="wb-module-progress-text">${archCount}/${totalCats} · ${fileCount} 文件</span>
          </div>
          <div class="wb-module-progress-track">
            <div class="wb-module-progress-fill" style="width:${pct}"></div>
          </div>
        </div>
      </div>
    `;
  };

  let html = '';
  // --- 关卡区块 + 新建按钮 ---
  html += `
    <div class="wb-section">
      <div class="wb-section-title">
        <span>🎯 关卡 <span class="wb-section-count">${levels.length}</span></span>
        <button class="wb-section-add" title="新建关卡" onclick="createNewLevel()">＋</button>
      </div>
      ${levels.length > 0
        ? `<div class="wb-module-list">${levels.map(renderModuleItem).join('')}</div>`
        : `<div class="wb-section-empty">暂无关卡，点击右上 ＋ 新建</div>`}
    </div>
  `;
  // --- 通用模块区块（折叠更紧凑） ---
  html += `
    <div class="wb-section">
      <div class="wb-section-title">
        <span>🧩 通用模块 <span class="wb-section-count">${commons.length}</span></span>
        <button class="wb-section-add" title="新建通用模块" onclick="createNewModule()">＋</button>
      </div>
      ${commons.length > 0
        ? `<div class="wb-module-list">${commons.map(renderModuleItem).join('')}</div>`
        : `<div class="wb-section-empty">暂无通用模块</div>`}
    </div>
  `;
  // --- 根目录未归档散文件（灯下黑） ---
  html += renderLooseFilesBlock(looseFiles);

  sidebar.innerHTML = html;
}

function renderLooseFilesBlock(looseFiles) {
  if (!looseFiles || looseFiles.length === 0) return '';
  const imgFiles = looseFiles.filter(f => f.is_image);
  const previewImgs = imgFiles.slice(0, 6).map(f => `
    <div class="wb-loose-thumb" onclick="openImageLightbox('${_escAttr(f.path)}', window._wbLooseImages || [])" data-path="${_escHtml(f.path)}">
      <img src="/api/thumb?path=${encodeURIComponent(f.path)}&size=96" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="wb-loose-thumb-name">${_escHtml(f.name)}</div>
    </div>
  `).join('');
  // 把图片列表挂到 window 上供 lightbox 使用
  setTimeout(() => { window._wbLooseImages = imgFiles.map(f => f.path); }, 0);
  return `
    <div class="wb-loose-section">
      <div class="wb-loose-header">
        <span class="wb-loose-title">⚠️ 根目录未归档</span>
        <span class="wb-loose-count">${looseFiles.length} 个</span>
      </div>
      <div class="wb-loose-hint">这些文件直接放在项目根下，建议分到关卡里</div>
      ${previewImgs ? `<div class="wb-loose-grid">${previewImgs}${imgFiles.length > 6 ? `<div class="wb-loose-more">+${imgFiles.length - 6}</div>` : ''}</div>` : ''}
      <button class="wb-btn-sm wb-btn-primary wb-loose-action" onclick="openOrganizeForModule(_getCurrentProject().path)">🚀 整理根目录散文件</button>
    </div>
  `;
}

function _escAttr(s) {
  return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ---- ➕ 新建关卡/模块 ----
async function createNewLevel() {
  const cur = _getCurrentProject();
  if (!cur) { showToast('请先选择项目', 'error'); return; }

  // 先询问用户：自动编号还是自定义名字
  const name = prompt('新关卡名称（留空自动命名为"关卡XX"）：', '');
  if (name === null) return;  // 用户取消

  try {
    const resp = await fetch('/api/project/create_level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: cur.path,
        name: name.trim(),
        module_type: 'level',
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    showToast(`✓ 已创建「${data.name}」`, 'success');
    // 刷新扫描并自动选中新关卡
    await scanProjectModules();
    if (data.path) selectModule(data.path);
  } catch (e) {
    showToast(`创建失败：${e.message}`, 'error');
  }
}

async function createNewModule(presetType) {
  const cur = _getCurrentProject();
  if (!cur) { showToast('请先选择项目', 'error'); return; }

  let mtype = presetType;
  if (!mtype) {
    const choice = prompt(
      '选择模块类型：\n1 = 主页特效\n2 = 通用UI\n3 = 加载页\n4 = 自定义名称\n\n请输入 1-4：',
      '1'
    );
    if (choice === null) return;
    const map = { '1': 'home', '2': 'common_ui', '3': 'loading', '4': 'custom' };
    mtype = map[choice.trim()] || 'custom';
  }

  let name = '';
  if (mtype === 'custom') {
    name = prompt('请输入模块目录名：', '');
    if (name === null || !name.trim()) return;
    name = name.trim();
    mtype = 'other';
  }

  try {
    const resp = await fetch('/api/project/create_level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: cur.path,
        name: name,
        module_type: mtype,
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    showToast(`✓ 已创建「${data.name}」`, 'success');
    await scanProjectModules();
    if (data.path) selectModule(data.path);
  } catch (e) {
    showToast(`创建失败：${e.message}`, 'error');
  }
}

function selectModule(modulePath) {
  wbState.currentModulePath = modulePath;

  // 刷新左栏激活态
  document.querySelectorAll('.wb-module-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === modulePath);
  });

  // 🎮 刷新游戏库里的关卡高亮
  const cur = _getCurrentProject();
  if (cur && typeof renderGameLevels === 'function') {
    renderGameLevels(cur.id);
  }

  // 右栏显示 board
  const emptyEl = document.getElementById('wbMainEmpty');
  const boardEl = document.getElementById('wbMainBoard');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (boardEl) boardEl.classList.remove('hidden');

  // 拉取该模块的详细分类（用缓存）
  loadModuleBoard(modulePath);
}

async function loadModuleBoard(modulePath, forceReload) {
  const boardEl = document.getElementById('wbMainBoard');
  if (!boardEl) return;

  if (!forceReload && wbState.moduleScanCache[modulePath]) {
    renderModuleBoard(modulePath, wbState.moduleScanCache[modulePath]);
    return;
  }

  boardEl.innerHTML = '<div class="wb-loading">⏳ 正在扫描该模块的文件分类...</div>';

  try {
    const resp = await fetch('/api/organize/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: modulePath })
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      const detail = data.path ? ` [后端看到的路径: ${data.path}]` : '';
      throw new Error((data.error || `HTTP ${resp.status}`) + detail);
    }
    wbState.moduleScanCache[modulePath] = data;
    renderModuleBoard(modulePath, data);
  } catch (e) {
    boardEl.innerHTML = `<div class="wb-error">❌ 扫描失败：${_escHtml(e.message)}</div>`;
    showToast(`扫描模块失败：${e.message}`, 'error');
  }
}

function renderModuleBoard(modulePath, data) {
  const boardEl = document.getElementById('wbMainBoard');
  if (!boardEl) return;

  // 从 scanResult 里找到这个模块的元信息（名称、类型）
  const sr = wbState.scanResult || {};
  const all = [...(sr.levels || []), ...(sr.common_modules || [])];
  const meta = all.find(m => m.path === modulePath) || { name: modulePath.split(/[\\/]/).pop(), module_type: 'other' };

  const cats = data.categories || {};
  const stats = data.stats || {};

  const renderCard = (catId) => {
    const def = FILE_CATEGORIES[catId];
    if (!def) return '';
    const files = cats[catId] || [];
    const cnt = files.length;
    const preview = files.slice(0, 8).map(f => `
      <div class="wb-tile" title="${_escHtml(f.name)}"
           data-file-path="${_escHtml(f.path)}"
           data-cat="${catId}"
           data-is-image="${_isImage(f.name) ? '1' : '0'}">
        ${_isImage(f.name)
          ? `<img src="/api/thumb?path=${encodeURIComponent(f.path)}&size=96" alt="${_escHtml(f.name)}" loading="lazy" onerror="this.style.display='none'" onclick="event.stopPropagation();openImageLightbox('${_escAttr(f.path)}', _wbCollectImages('${catId}'))" style="cursor:zoom-in">`
          : `<div class="wb-tile-icon">${def.icon}</div>`}
        <div class="wb-tile-check">✓</div>
        <div class="wb-tile-name">${_escHtml(f.name)}</div>
      </div>
    `).join('');
    const more = cnt > 8 ? `<div class="wb-tile wb-tile-more" data-cat="${catId}" data-action="expand-cat">+${cnt - 8}</div>` : '';

    return `
      <div class="wb-card ${cnt > 0 ? '' : 'wb-card-empty'}" data-cat="${catId}">
        <div class="wb-card-header">
          <span class="wb-card-icon">${def.icon}</span>
          <span class="wb-card-title">${_escHtml(def.name)}</span>
          <span class="wb-card-count ${cnt > 0 ? 'has' : ''}">${cnt}</span>
        </div>
        <div class="wb-card-desc">${_escHtml(def.desc)}</div>
        <div class="wb-card-body">
          ${cnt > 0 ? (preview + more) : `<div class="wb-card-placeholder">暂无文件</div>`}
        </div>
      </div>
    `;
  };

  const mainCards = WB_BOARD_ORDER.map(renderCard).join('');
  const processCards = WB_PROCESS_CATS.map(renderCard).join('');
  const unknownCount = (cats.unknown || []).length;

  boardEl.innerHTML = `
    <div class="wb-board-head">
      <div class="wb-board-title-row">
        <span class="wb-board-type-icon">${MODULE_TYPE_ICON[meta.module_type] || '📁'}</span>
        <h3 class="wb-board-title">${_escHtml(meta.name)}</h3>
        <span class="wb-board-type">${_escHtml(MODULE_TYPE_LABEL[meta.module_type] || '')}</span>
        <button class="wb-btn-sm" data-wb-action="open-explorer" data-path="${_escHtml(modulePath)}">📂 在资源管理器中打开</button>
        <button class="wb-btn-sm" data-wb-action="rescan">🔄 重新扫描</button>
        <button class="wb-btn-sm wb-btn-primary" data-wb-action="open-organize" data-path="${_escHtml(modulePath)}">🚀 打开快速归档</button>
      </div>
      <div class="wb-board-stats">
        <span>📦 共 ${stats.total_files || 0} 文件</span>
        <span>✅ 已分类 ${stats.classified || 0}</span>
        <span class="${unknownCount > 0 ? 'wb-warn' : ''}">❓ 未分类 ${stats.unclassified || 0}</span>
        <span>💾 ${stats.total_size_human || '0 B'}</span>
      </div>
      <div class="wb-selection-bar hidden" id="wbSelectionBar">
        <span class="wb-sel-count">已选 <strong id="wbSelCount">0</strong> 项</span>
        <div class="wb-sel-actions">
          <button class="wb-btn-sm" data-wb-action="sel-open">🔎 打开所在位置</button>
          <button class="wb-btn-sm" data-wb-action="sel-move">📂 移到其他分类</button>
          <button class="wb-btn-sm" data-wb-action="sel-clear">✖ 取消选择</button>
        </div>
      </div>
    </div>

    <div class="wb-cards-grid">
      ${mainCards}
    </div>

    <!-- 过程文件：默认折叠 -->
    <div class="wb-drawer" id="wbProcessDrawer">
      <div class="wb-drawer-header" onclick="toggleWbDrawer()">
        <span class="wb-drawer-chevron" id="wbDrawerChevron">▶</span>
        <span class="wb-drawer-title">📝 过程文件（默认折叠）</span>
        <span class="wb-drawer-count">${WB_PROCESS_CATS.reduce((s, c) => s + ((cats[c] || []).length), 0)} 个</span>
      </div>
      <div class="wb-drawer-body hidden" id="wbDrawerBody">
        <div class="wb-cards-grid">${processCards}</div>
      </div>
    </div>

    ${unknownCount > 0 ? `
      <div class="wb-unknown-hint">
        <span>⚠️ 还有 ${unknownCount} 个文件未自动分类，建议：</span>
        <button class="wb-btn-sm wb-btn-primary" data-wb-action="open-organize" data-path="${_escHtml(modulePath)}">🚀 用快速归档模式人工/AI 归档</button>
      </div>
    ` : ''}
  `;
}

function _isImage(name) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name || '');
}

function toggleWbDrawer() {
  const chev = document.getElementById('wbDrawerChevron');
  const body = document.getElementById('wbDrawerBody');
  if (!body) return;
  const hidden = body.classList.toggle('hidden');
  if (chev) chev.textContent = hidden ? '▶' : '▼';
}

function refreshWorkbench() {
  const cur = _getCurrentProject();
  if (!cur) return;
  wbState.scanResult = null;
  wbState.moduleScanCache = {};
  // 保留当前选中路径，扫完后若还存在则自动高亮
  const keepPath = wbState.currentModulePath;
  wbState.currentModulePath = null;
  scanProjectModules().then(() => {
    if (keepPath && wbState.scanResult) {
      const all = [...(wbState.scanResult.levels || []), ...(wbState.scanResult.common_modules || [])];
      if (all.some(m => m.path === keepPath)) {
        selectModule(keepPath);
      }
    }
  });
  showToast('正在刷新项目结构...', 'info');
}

function rescanCurrentModule() {
  if (!wbState.currentModulePath) return;
  loadModuleBoard(wbState.currentModulePath, true);
}

function openInExplorer(path) {
  fetch('/api/open_folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  }).catch(() => {});
}

function openOrganizeForModule(modulePath) {
  // 复用现有的 organize 弹窗，填入路径并直接切到快速归档
  if (typeof lingxi !== 'undefined' && lingxi && typeof lingxi.openOrganize === 'function') {
    lingxi.openOrganize();
  } else {
    document.getElementById('organizeModal')?.classList.remove('hidden');
  }
  const input = document.getElementById('organizeRoot');
  if (input) input.value = modulePath;
  if (typeof switchToQuickArchive === 'function') {
    setTimeout(() => switchToQuickArchive(), 100);
  }
}

// ---- Step 2.1: 事件委托（用 data-path 替代 inline onclick，规避反斜杠被吞） ----

// ================================================================
// 🔍 图片 Lightbox（点击 wb-tile 的图/loose 图直接放大）
// ================================================================
const lightboxState = {
  list: [],        // 当前组的图片路径列表
  index: 0,
  naturalSize: null,
  zoomMode: 'fit', // 'fit' | '1'
};

function openImageLightbox(path, list) {
  if (!path) return;
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;

  lightboxState.list = (list && list.length) ? list : [path];
  lightboxState.index = Math.max(0, lightboxState.list.indexOf(path));
  if (lightboxState.index < 0) lightboxState.index = 0;
  lightboxState.zoomMode = 'fit';

  _lightboxShowCurrent();
  overlay.classList.remove('hidden');
  document.addEventListener('keydown', _lightboxOnKey);
}

function closeImageLightbox(e) {
  if (e && e.target && e.target.id !== 'lightboxOverlay' && !e.target.classList.contains('lightbox-content')) {
    // 仅点击空白/遮罩才关闭
    if (!e.target.classList.contains('lightbox-close')) return;
  }
  const overlay = document.getElementById('lightboxOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.removeEventListener('keydown', _lightboxOnKey);
  const img = document.getElementById('lightboxImage');
  if (img) img.src = '';
}

function lightboxPrev() {
  if (lightboxState.list.length === 0) return;
  lightboxState.index = (lightboxState.index - 1 + lightboxState.list.length) % lightboxState.list.length;
  _lightboxShowCurrent();
}
function lightboxNext() {
  if (lightboxState.list.length === 0) return;
  lightboxState.index = (lightboxState.index + 1) % lightboxState.list.length;
  _lightboxShowCurrent();
}
function lightboxZoom(mode) {
  lightboxState.zoomMode = mode;
  const img = document.getElementById('lightboxImage');
  if (!img) return;
  if (mode === 1 || mode === '1') {
    img.classList.add('lightbox-zoom-1');
  } else {
    img.classList.remove('lightbox-zoom-1');
  }
}
function lightboxOpenInExplorer() {
  const p = lightboxState.list[lightboxState.index];
  if (!p) return;
  fetch('/api/open_folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p })
  }).catch(() => {});
}

function _lightboxShowCurrent() {
  const p = lightboxState.list[lightboxState.index];
  if (!p) return;
  const img = document.getElementById('lightboxImage');
  const caption = document.getElementById('lightboxCaption');
  const counter = document.getElementById('lightboxCounter');
  if (img) {
    img.classList.remove('lightbox-zoom-1');
    // 直接请求原图（不走缩略图）
    img.src = `/api/raw?path=${encodeURIComponent(p)}`;
    img.onerror = () => {
      img.src = `/api/thumb?path=${encodeURIComponent(p)}&size=1024`;
    };
  }
  if (caption) {
    const name = p.split(/[\\/]/).pop();
    caption.textContent = name;
    caption.title = p;
  }
  if (counter) {
    counter.textContent = `${lightboxState.index + 1} / ${lightboxState.list.length}`;
  }
}

function _lightboxOnKey(e) {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('lightboxOverlay');
    if (overlay) overlay.classList.add('hidden');
    document.removeEventListener('keydown', _lightboxOnKey);
  } else if (e.key === 'ArrowLeft') {
    lightboxPrev();
  } else if (e.key === 'ArrowRight') {
    lightboxNext();
  } else if (e.key === ' ' || e.key === 'Enter') {
    lightboxNext();
    e.preventDefault();
  }
}

// 从当前看板某分类收集所有图片路径供 lightbox 切换
function _wbCollectImages(catId) {
  try {
    const path = wbState.currentModulePath;
    const data = path && wbState.moduleScanCache && wbState.moduleScanCache[path];
    if (!data) return [];
    const files = (data.categories && data.categories[catId]) || [];
    return files.filter(f => _isImage(f.name)).map(f => f.path);
  } catch (e) {
    return [];
  }
}

// 当前选中的文件集合（在工作台看板中）
const wbSelection = {
  paths: new Set(),
  catsByPath: {}, // path -> catId
};

function _wbUpdateSelectionUI() {
  // 同步 .selected 样式
  document.querySelectorAll('.wb-tile[data-file-path]').forEach(el => {
    el.classList.toggle('selected', wbSelection.paths.has(el.dataset.filePath));
  });
  // 同步底部选择工具栏
  const bar = document.getElementById('wbSelectionBar');
  const cntEl = document.getElementById('wbSelCount');
  if (bar && cntEl) {
    const n = wbSelection.paths.size;
    cntEl.textContent = String(n);
    bar.classList.toggle('hidden', n === 0);
  }
}

function _wbToggleTile(tile, isMulti) {
  const p = tile.dataset.filePath;
  if (!p) return;
  if (!isMulti) {
    // 单击：如果只有它一个且已选中 → 取消；否则独占选中
    const wasSolo = wbSelection.paths.size === 1 && wbSelection.paths.has(p);
    wbSelection.paths.clear();
    if (!wasSolo) wbSelection.paths.add(p);
  } else {
    // Ctrl/多选模式
    if (wbSelection.paths.has(p)) wbSelection.paths.delete(p);
    else wbSelection.paths.add(p);
  }
  wbSelection.catsByPath[p] = tile.dataset.cat;
  _wbUpdateSelectionUI();
}

function _wbClearSelection() {
  wbSelection.paths.clear();
  _wbUpdateSelectionUI();
}

function _wbOpenSelectedInExplorer() {
  const first = [...wbSelection.paths][0];
  if (!first) return;
  // 定位到文件所在目录
  const parent = first.replace(/[\\/][^\\/]+$/, '');
  openInExplorer(parent);
}

async function _wbMoveSelectionToCategory() {
  if (wbSelection.paths.size === 0) return;
  const cats = Object.entries(FILE_CATEGORIES)
    .filter(([k]) => k !== 'unknown')
    .map(([k, v]) => `${v.icon} ${v.name}`).join('\n');
  const catKeys = Object.keys(FILE_CATEGORIES).filter(k => k !== 'unknown');
  const promptMsg = `把选中的 ${wbSelection.paths.size} 个文件移动到：\n${catKeys.map((k,i)=>`${i+1}. ${FILE_CATEGORIES[k].icon} ${FILE_CATEGORIES[k].name}`).join('\n')}\n\n请输入序号：`;
  const idx = prompt(promptMsg, '1');
  if (!idx) return;
  const n = parseInt(idx, 10);
  if (isNaN(n) || n < 1 || n > catKeys.length) {
    showToast('无效的分类序号', 'error');
    return;
  }
  const targetCat = catKeys[n - 1];
  const moves = [...wbSelection.paths].map(p => ({ src: p, category: targetCat }));
  try {
    const resp = await fetch('/api/organize/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: wbState.currentModulePath, moves })
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    showToast(`✓ 已移动 ${moves.length} 个文件到「${FILE_CATEGORIES[targetCat].name}」`, 'success');
    _wbClearSelection();
    if (typeof rescanCurrentModule === 'function') rescanCurrentModule();
  } catch (e) {
    showToast(`移动失败：${e.message}`, 'error');
  }
}

function setupWorkbenchDelegation() {
  if (window.__wbDelegationReady) return;
  window.__wbDelegationReady = true;

  // 单击：左侧关卡项、按钮、tile 选中切换
  document.addEventListener('click', (e) => {
    // 1) 关卡列表点击 → selectModule
    const moduleItem = e.target.closest('.wb-module-item');
    if (moduleItem && moduleItem.dataset.path) {
      selectModule(moduleItem.dataset.path);
      return;
    }
    // 2) 看板按钮：data-wb-action
    const actionEl = e.target.closest('[data-wb-action]');
    if (actionEl) {
      const action = actionEl.dataset.wbAction;
      const p = actionEl.dataset.path;
      if (action === 'open-explorer' && p) {
        openInExplorer(p);
      } else if (action === 'open-organize' && p) {
        openOrganizeForModule(p);
      } else if (action === 'rescan') {
        rescanCurrentModule();
      } else if (action === 'sel-open') {
        _wbOpenSelectedInExplorer();
      } else if (action === 'sel-move') {
        _wbMoveSelectionToCategory();
      } else if (action === 'sel-clear') {
        _wbClearSelection();
      }
      return;
    }
    // 3) 看板文件 tile：切换选中
    const tile = e.target.closest('.wb-tile[data-file-path]');
    if (tile) {
      _wbToggleTile(tile, e.ctrlKey || e.metaKey);
      return;
    }
    // 4) 点击看板空白区域 → 清空选中
    if (e.target.closest('#wbMainBoard') && !e.target.closest('.wb-selection-bar')) {
      _wbClearSelection();
    }
    // 5) 目录选择器 browserModal：单击选中当前文件夹（把路径填入输入框）
    const browserItem = e.target.closest('.browser-modal .browser-item[data-path]');
    if (browserItem) {
      document.querySelectorAll('.browser-modal .browser-item.selected')
        .forEach(el => el.classList.remove('selected'));
      browserItem.classList.add('selected');
      const p = browserItem.dataset.path;
      const input = document.getElementById('browserPath');
      if (input) input.value = p;
      if (window.lingxi && window.lingxi.browserState) {
        window.lingxi.browserState.path = p;
      }
      return;
    }
  });

  // 双击 tile：在资源管理器中定位
  document.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('.wb-tile[data-file-path]');
    if (tile && tile.dataset.filePath) {
      const parent = tile.dataset.filePath.replace(/[\\/][^\\/]+$/, '');
      openInExplorer(parent);
      return;
    }
    // 双击 browser-item → 进入该目录
    const browserItem = e.target.closest('.browser-modal .browser-item[data-path]');
    if (browserItem && browserItem.dataset.path) {
      if (window.lingxi) window.lingxi.browserNavigate(browserItem.dataset.path);
    }
  });
}

// ---- 启动：等待 DOM 和 lingxi 准备好后初始化 ----
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadProjectsFromConfig();
    setupWorkbenchDelegation();
    setupGameLibraryDelegation();
  });
} else {
  loadProjectsFromConfig();
  setupWorkbenchDelegation();
  setupGameLibraryDelegation();
}

// ============================================================
// 🎮 游戏库侧栏（Game Library）
// ============================================================

// 游戏库状态（每个项目的"展开/折叠"、各项目的扫描数据缓存）
const glState = {
  expandedId: null,           // 当前展开的游戏项目 ID
  projectScans: {},           // { [projectId]: scanResult }  缓存每个项目的扫描结果
  searchText: '',
  openMenuId: null,
};

/** 主入口：渲染整个游戏库（顶栏计数 + 卡片列表） */
function renderGameLibrary() {
  const listEl = document.getElementById('glList');
  const countEl = document.getElementById('glCount');
  if (!listEl) return;

  const list = projectsState.list || [];
  if (countEl) countEl.textContent = list.length;

  // 空状态
  if (list.length === 0) {
    listEl.innerHTML = `
      <div class="gl-empty">
        <div class="gl-empty-icon">🕹️</div>
        <p class="gl-empty-title">还没有游戏项目</p>
        <p class="gl-empty-hint">点击下方按钮添加你的第一个游戏</p>
      </div>`;
    return;
  }

  // 应用搜索过滤
  const kw = (glState.searchText || '').trim().toLowerCase();
  const filtered = kw
    ? list.filter(p => (p.name || '').toLowerCase().includes(kw) || (p.path || '').toLowerCase().includes(kw))
    : list;

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="gl-empty">
        <div class="gl-empty-icon">🔍</div>
        <p class="gl-empty-title">没有匹配的游戏</p>
        <p class="gl-empty-hint">换个关键词试试</p>
      </div>`;
    return;
  }

  // 当前激活 ID = 选中的项目
  const activeId = projectsState.currentId;
  // 默认展开当前激活项目
  if (glState.expandedId == null && activeId) {
    glState.expandedId = activeId;
  }

  listEl.innerHTML = filtered.map(p => _renderGameCard(p, activeId)).join('');

  // 每张展开的卡片都需要渲染其关卡
  filtered.forEach(p => {
    if (p.id === glState.expandedId) {
      renderGameLevels(p.id);
    }
  });
}

function _renderGameCard(p, activeId) {
  const isActive = p.id === activeId;
  const isExpanded = p.id === glState.expandedId;
  const scan = glState.projectScans[p.id];

  // 整体进度：基于扫描结果，未扫描则显示 --
  let pct = 0, hasProgress = false, totalMods = 0, doneMods = 0;
  if (scan) {
    const all = [...(scan.levels || []), ...(scan.common_modules || [])];
    totalMods = all.length;
    doneMods = all.filter(m => (m.progress || 0) >= 0.5).length;
    pct = totalMods > 0 ? Math.round((doneMods / totalMods) * 100) : 0;
    hasProgress = true;
  }

  const typeLabel = PROJECT_TYPE_LABEL[p.type] || '';
  const statusColor = PROJECT_STATUS_COLOR[p.status] || '#8a8aa8';
  const avatar = _escHtml((p.name || '🎮').slice(0, 1));

  return `
    <div class="gl-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''}"
         data-project-id="${_escHtml(p.id)}">
      <div class="gl-card-head" onclick="toggleGameCard('${_escHtml(p.id)}')">
        <div class="gl-card-avatar" style="background: linear-gradient(135deg, ${_pickAvatarColor(p.id)});">
          ${avatar}
        </div>
        <div class="gl-card-body-info">
          <div class="gl-card-name-row">
            <span class="gl-card-name" title="${_escHtml(p.name)}">${_escHtml(p.name)}</span>
            ${typeLabel ? `<span class="gl-card-type-tag">${_escHtml(typeLabel)}</span>` : ''}
            ${isActive ? `<span class="gl-card-active-dot" title="当前项目"></span>` : ''}
          </div>
          <div class="gl-card-meta-row">
            <span class="project-status-dot" style="width:6px;height:6px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
            <div class="gl-card-progress-mini" title="${hasProgress ? (doneMods + '/' + totalMods + ' 模块已归档') : '尚未扫描'}">
              <div class="gl-card-progress-mini-fill" style="width:${pct}%"></div>
            </div>
            <span class="gl-card-pct">${hasProgress ? pct + '%' : '--'}</span>
          </div>
        </div>
        <div class="gl-card-actions">
          <button class="gl-card-more" onclick="event.stopPropagation(); openGameCardMenu(event, '${_escHtml(p.id)}')" title="更多">⋮</button>
          <svg class="gl-card-caret" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M7 10l5 5 5-5z"/>
          </svg>
        </div>
      </div>
      <div class="gl-card-body">
        <div class="gl-levels" id="glLevels-${_escHtml(p.id)}">
          <div class="gl-levels-loading">⏳ 等待扫描...</div>
        </div>
      </div>
    </div>
  `;
}

/** 在展开的卡片内渲染关卡列表（基于 scan 数据） */
function renderGameLevels(projectId) {
  const container = document.getElementById(`glLevels-${projectId}`);
  if (!container) return;

  const scan = glState.projectScans[projectId];
  if (!scan) {
    // 还没扫描过 → 发起扫描（只对当前项目，否则等待展开时再扫）
    if (projectId === projectsState.currentId) {
      container.innerHTML = '<div class="gl-levels-loading">⏳ 正在扫描关卡...</div>';
      // 让当前逻辑走 scanProjectModules，它会更新 wbState.scanResult；这里只等待回写
    } else {
      container.innerHTML = '<div class="gl-levels-loading">点击切换到此项目以扫描关卡</div>';
    }
    return;
  }

  const levels = scan.levels || [];
  const commons = scan.common_modules || [];
  const currentModulePath = (projectId === projectsState.currentId) ? wbState.currentModulePath : null;

  const renderLevel = (m) => {
    const p = m.progress || 0;
    let statusClass = 'status-empty', statusIcon = '○';
    if (p >= 0.999) { statusClass = 'status-done'; statusIcon = '✓'; }
    else if (p > 0) { statusClass = 'status-progress'; statusIcon = '●'; }
    const isActive = m.path === currentModulePath;
    const typeTag = m.module_type && m.module_type !== 'level'
      ? `<span class="gl-level-tag">${_escHtml(MODULE_TYPE_LABEL[m.module_type] || '')}</span>`
      : '';
    return `
      <div class="gl-level ${statusClass} ${isActive ? 'active' : ''}"
           data-module-path="${_escHtml(m.path)}"
           onclick="event.stopPropagation(); selectLevelFromLibrary('${_escHtml(projectId)}', '${_escAttr(m.path)}')">
        <span class="gl-level-status">${statusIcon}</span>
        <span class="gl-level-name" title="${_escHtml(m.path)}">${_escHtml(m.name)}</span>
        ${typeTag}
        <span class="gl-level-pct">${Math.round(p * 100)}%</span>
      </div>
    `;
  };

  let html = '';
  if (levels.length > 0) {
    html += `
      <div class="gl-level-section-title">
        <span>关卡 · ${levels.length}</span>
        <button class="gl-level-section-add" title="新建关卡"
                onclick="event.stopPropagation(); createNewLevelForProject('${_escHtml(projectId)}')">+</button>
      </div>
      ${levels.map(renderLevel).join('')}
    `;
  } else {
    html += `
      <div class="gl-level-section-title"><span>关卡</span></div>
      <div class="gl-levels-empty">暂无关卡</div>
    `;
  }

  if (commons.length > 0) {
    html += `
      <div class="gl-level-section-title" style="margin-top:6px;">
        <span>通用模块 · ${commons.length}</span>
      </div>
      ${commons.map(renderLevel).join('')}
    `;
  }

  // 新建关卡虚线按钮
  html += `
    <button class="gl-level-new-btn"
            onclick="event.stopPropagation(); createNewLevelForProject('${_escHtml(projectId)}')">
      ＋ 新建关卡
    </button>
  `;

  container.innerHTML = html;
}

/** 点击卡片头：切换展开 + 切换当前项目 */
function toggleGameCard(projectId) {
  // 如果点击的是当前展开的卡片，则折叠
  if (glState.expandedId === projectId && projectsState.currentId === projectId) {
    glState.expandedId = null;
    renderGameLibrary();
    return;
  }
  // 否则切换项目（项目切换会自动展开这张卡片）
  if (projectsState.currentId !== projectId) {
    switchProject(projectId);
  } else {
    glState.expandedId = projectId;
    renderGameLibrary();
  }
}

/** 游戏库：从关卡项点击 → 同时切项目 + 选中关卡 */
function selectLevelFromLibrary(projectId, modulePath) {
  if (projectsState.currentId !== projectId) {
    switchProject(projectId);
    // 切换后等扫描完成再选中
    const tryPick = (tries = 20) => {
      if (glState.projectScans[projectId]) {
        if (typeof selectModule === 'function') selectModule(modulePath);
      } else if (tries > 0) {
        setTimeout(() => tryPick(tries - 1), 150);
      }
    };
    tryPick();
  } else {
    if (typeof selectModule === 'function') selectModule(modulePath);
    renderGameLevels(projectId);
  }
}

/** 卡片 ⋮ 菜单 */
function openGameCardMenu(ev, projectId) {
  closeGameCardMenu();
  const menu = document.createElement('div');
  menu.className = 'gl-card-menu';
  menu.id = 'glCardMenu';
  menu.innerHTML = `
    <div class="gl-card-menu-item" onclick="switchProject('${_escHtml(projectId)}'); closeGameCardMenu();">📂 切换到此项目</div>
    <div class="gl-card-menu-item" onclick="openProjectInExplorer('${_escHtml(projectId)}'); closeGameCardMenu();">📁 在资源管理器打开</div>
    <div class="gl-card-menu-sep"></div>
    <div class="gl-card-menu-item" onclick="openAddProject('${_escHtml(projectId)}'); closeGameCardMenu();">✏️ 编辑项目信息</div>
    <div class="gl-card-menu-item" onclick="refreshProjectScan('${_escHtml(projectId)}'); closeGameCardMenu();">🔄 重新扫描</div>
    <div class="gl-card-menu-sep"></div>
    <div class="gl-card-menu-item danger" onclick="deleteProject('${_escHtml(projectId)}'); closeGameCardMenu();">🗑️ 删除项目（仅移除记录）</div>
  `;
  document.body.appendChild(menu);
  const rect = ev.target.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 160) + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  glState.openMenuId = projectId;
  setTimeout(() => {
    document.addEventListener('click', closeGameCardMenu, { once: true });
  }, 0);
}
function closeGameCardMenu() {
  const m = document.getElementById('glCardMenu');
  if (m) m.remove();
  glState.openMenuId = null;
}

/** 搜索过滤 */
function filterGameLibrary(text) {
  glState.searchText = text || '';
  renderGameLibrary();
}

/** 在资源管理器打开项目目录 */
function openProjectInExplorer(projectId) {
  const p = projectsState.list.find(x => x.id === projectId);
  if (!p) return;
  fetch('/api/open_folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p.path })
  }).catch(() => {});
}

/** 重新扫描某个项目 */
function refreshProjectScan(projectId) {
  delete glState.projectScans[projectId];
  if (projectsState.currentId === projectId) {
    wbState.scanResult = null;
    wbState.moduleScanCache = {};
    if (typeof scanProjectModules === 'function') scanProjectModules();
  } else {
    renderGameLibrary();
  }
}

/** 删除项目（仅从列表移除，不动磁盘文件） */
async function deleteProject(projectId) {
  const p = projectsState.list.find(x => x.id === projectId);
  if (!p) return;
  if (!confirm(`确定从列表中移除「${p.name}」吗？\n（磁盘上的文件不会被删除）`)) return;
  projectsState.list = projectsState.list.filter(x => x.id !== projectId);
  if (projectsState.currentId === projectId) {
    projectsState.currentId = projectsState.list[0] ? projectsState.list[0].id : null;
    localStorage.setItem('lingxi.currentProjectId', projectsState.currentId || '');
    if (glState.expandedId === projectId) glState.expandedId = projectsState.currentId;
  }
  delete glState.projectScans[projectId];
  await saveProjectsToConfig();
  renderGameLibrary();
  renderProjectSwitcher();
  renderWorkbenchView();
  showToast(`已移除「${p.name}」`, 'success');
}

/** 为指定项目创建新关卡（先切换再创建） */
function createNewLevelForProject(projectId) {
  if (projectsState.currentId !== projectId) {
    switchProject(projectId);
    setTimeout(() => {
      if (typeof createNewLevel === 'function') createNewLevel();
    }, 300);
  } else {
    if (typeof createNewLevel === 'function') createNewLevel();
  }
}

/** 事件委托（右键菜单、外部点击关闭等） */
function setupGameLibraryDelegation() {
  // ESC 关闭菜单
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeGameCardMenu();
  });
}

/** 头像渐变色：按项目 id 生成固定颜色 */
function _pickAvatarColor(id) {
  const palettes = [
    '#6c5ce7, #00cec9',
    '#ff6b6b, #ffa502',
    '#fd79a8, #a29bfe',
    '#00b894, #00cec9',
    '#fdcb6e, #e17055',
    '#74b9ff, #0984e3',
    '#55efc4, #00b894',
    '#e84393, #fd79a8',
  ];
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palettes[h % palettes.length];
}

// ============================================================
// 🔌 桥接：这些函数已在定义处直接调用 renderGameLibrary/renderGameLevels
// （loadProjectsFromConfig / scanProjectModules / switchProject）
// 所以这里不再需要额外包装。
// ============================================================


