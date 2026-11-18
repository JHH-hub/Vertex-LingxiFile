# CLAUDE.md · Vertex-LingxiFile (灵犀文件管家) AI 上下文导航

> 本文档与 [AGENTS.md](AGENTS.md) 保持同步，面向 Claude Code 及所有协作 AI Agent。

---

## 1. 项目定位与架构演进（重要上下文）

**灵犀文件管家（LingXi File Manager）** 是面向小游戏美术工作流的本地素材归档工作台与智能文件管理系统，采用 **Flask + Flask-SocketIO + SQLite + 原生 JS/CSS** 构建，默认运行在本地 `http://127.0.0.1:7870`。

> **架构现状说明（避免被旧版 README 误导）**：
> - `README.md` 描述的是早期通用文件浏览器形态，但当前前端（`templates/index.html` + `static/app.js`）已演进为 **`app-workbench-only`（游戏素材归档工作台模式）**。
> - 当前主界面由左侧 **游戏库（Game Library 手风琴卡片）** 与右侧 **关卡/模块归档看板（Workbench Board）** 组成，围绕「游戏项目 → 关卡/通用模块 → 10 类美术素材规则扫描 + AI 视觉分类 → 结构化归档落盘与一键撤销」运转。
> - 后端 `server.py` 同时完整保留了通用文件管理、目录树、标签、收藏、操作历史、MD5 重复文件检测、Spine 资源组扫描及 OpenAI 兼容 AI 重命名等全量接口。

---

## 2. 目录与模块职责表

| 文件 / 目录 | 规模 | 核心职责与关键实现 |
| :--- | :--- | :--- |
| `server.py` | ~2540 行 | Flask + SocketIO 后端主程序。含启动依赖自检 `_ensure_deps()`、静态文件防缓存钩子 `_no_cache_static()`、SQLite 初始化 `init_db()`、通用文件 CRUD、游戏项目工作台 API、规则+LLM 归档分类引擎。 |
| `static/app.js` | ~4470 行 | 前端交互核心。包含基础类 `LingXiFileManager`、游戏项目与工作台状态管理（`projectsState` / `wbState`）、左侧游戏库手风琴组件（`glState` / `renderGameLibrary` / `renderGameLevels`）、关卡归档看板、快速归档弹窗（拖拽归档 + AI 识图）、图片 Lightbox 预览器。 |
| `templates/index.html` | ~410 行 | 单页工作台 HTML 模板（`.app-workbench-only`）。包含 `#gameLibrary` 侧栏、`#workbenchView` 主看板、`#detailsPanel` 详情栏，以及目录浏览、设置、操作历史、Lightbox、添加/管理项目、项目文件整理（`#organizeModal`）等模态框。 |
| `static/style.css` | ~110 KB | 现代化暗黑主题样式表，覆盖游戏库卡片、进度条、归档看板、快速归档网格、过程文件抽屉及 Lightbox 样式。 |
| `requirements.txt` | 5 行 | Python 依赖清单：`flask>=3.0.0`、`flask-socketio>=5.3.0`、`Pillow>=10.0.0`、`requests>=2.31.0`、`send2trash>=1.8.0`。 |
| `run.bat` | 53 行 | Windows 一键启动脚本：检查 Python 与 Flask 环境，自动安装缺失依赖并启动 `python server.py`。 |
| `_restart.ps1` | 7 行 | 开发调试用 PowerShell 重启脚本：强制停止现有 `python` 进程，后台重启 `server.py`（日志重定向至 `_s.log` / `_s.err`），并校验 `7870` 端口监听状态。 |
| `_data/` | 运行时目录 | 本地持久化目录：含 `config.json`（项目列表、根目录、AI 配置）、`lingxi.db`（SQLite 数据库，已在 `.gitignore` 忽略 `*.db`）和 `thumbs/`（缩略图缓存）。 |

---

## 3. 核心子系统与后端接口清单

### 3.1 游戏项目工作台与自动发现 (`server.py` L2119–L2509)
- **`POST /api/project/auto_discover`**：扫描指定根路径或全盘驱动器一级子目录，通过目录名关键词（`（游戏项目）`、`游戏`）或子目录含多个关卡目录（`关卡`、`第`、`level`、`chapter`）自动打分识别候选游戏项目，并推断项目类型（`zhaocha` 找茬 / `pintu` 拼图 / `other`）。
- **`POST /api/project/scan`**：快速扫描项目根目录。一级子目录按 `_guess_module_type()` 分为关卡（`levels`）和通用模块（`common_modules`：`home` 主页、`common_ui` 通用UI、`loading` 加载页、`other`），调用 `_infer_archive_status()` 统计已归档分类占比与文件数，并收集根目录下未归入子目录的散落文件（`loose_files`）。
- **`POST /api/project/create_level`**：在项目下新建关卡或模块目录。当 `name` 留空且 `module_type == 'level'` 时，自动正则匹配现有目录命名风格（如 `第N关`、`关卡NN`、`第N章`、`Level N`、`N关`）并按最大编号 `+1` 生成新目录名。

### 3.2 游戏素材分类与快速归档引擎 (`server.py` L1418–L2117)
- **分类字典 `FILE_CATEGORIES`**：
  | 分类 ID | 名称 | 归档目标子目录 (`folder`) | 识别规则简述 (`classify_file` / `classify_directory`) |
  | :--- | :--- | :--- | :--- |
  | `completion` | 完成图 | `_完成图` | 文件名含「效果图 / 完成图 / 完成 / 最终 / final」 |
  | `source` | 工程文件 | `_工程文件` | `.psd` / `.psb` / `.ai` / `.sketch` / `.xd` / `.fig` / `.spine` |
  | `spine_export` | 动画导出 | `_动画导出` | `skeleton.atlas/.json/.png/.skel` 或目录名含「导出 / export」 |
  | `cutout` | 切图素材 | `_切图素材` | 父目录含「切图 / 人物 / 角色」、文件名以「图层」开头或小于 200KB 的图片 |
  | `icon_set` | 收集栏图标 | `_收集栏图标` | `icon_001` 等正则 `^icon_\d+` 或目录含 `icon` / `收集栏` |
  | `background` | 底图 | `_底图` | 文件名含「底图 / 背景图 / bg」的图片 |
  | `process_ai` | 过程-AI生图 | `_过程文件/AI生图` | 匹配 `jimeng-YYYY-MM-DD-` 或 `图片生成-\d+` |
  | `process_ref` | 过程-参考截图 | `_过程文件/参考截图` | 含「企业微信截图 / 屏幕截图 / screenshot / 微信图片」 |
  | `process_draft` | 过程-草稿迭代 | `_过程文件/草稿迭代` | UUID 文件名、`canvas_node_` 前缀、大于 500KB 带数字尾号的大图或「过程」目录 |
  | `package` | 打包交付 | `_打包交付` | `.zip` / `.rar` / `.7z` / `.tar` / `.gz` |
  | `unknown` | 未分类 | `None` | 规则无法命中，交由人工或 LLM 分类 |
- **归档 API**：
  - `POST /api/organize/scan`：扫描关卡目录顶层文件、子目录及过程子目录，返回各分类文件列表与统计。
  - `POST /api/organize/llm_classify`：对未识别文件分两步调用 LLM（`_venus_chat`）：非图片走批量文件名分类；图片文件（最多 15 张）压缩为 512×512 JPEG base64 走视觉+OCR 识别内容分类。
  - `POST /api/organize/detect_project`：根据当前目录、父目录、兄弟目录及文件样本推测 `project_name`、`module_type` 与 `module_name`。
  - `POST /api/organize/execute`：将文件移动至 `<root>/<cat.folder>/<project_name>_<module_name>/`，重名自动追加 `_1`、`_2`，并在 `history` 表记录 `organize_move` 批次。
  - `POST /api/organize/undo`：按 `batch_id` 逆序将文件移回原路径并标记 `undone=1`。

### 3.3 通用文件管理、检索与 AI 重命名 (`server.py` L270–L1416)
- **基础浏览与预览**：`/api/config` (`GET`/`POST`)、`/api/drives`、`POST /api/list`、`POST /api/tree`、`GET /api/thumb`（生成并缓存 256px 缩略图至 `_data/thumbs/`）、`GET /api/raw`、`POST /api/preview_text`（支持 `utf-8`/`gbk`/`gb2312`/`latin-1` 自动解码）。
- **文件变更与历史回滚**：`POST /api/rename`、`POST /api/move`、`POST /api/copy`、`POST /api/delete`（默认 `send2trash` 安全移入系统回收站，传 `permanent: true` 才物理删除）、`POST /api/mkdir`、`POST /api/open_folder`、`POST /api/open_file`、`GET /api/history`、`POST /api/undo`（注意：重命名或移动文件时必须同步更新 `file_tags`、`favorites`、`ai_meta` 三张表的 `file_path` 主键/外键）。
- **标签、收藏、查重与 Spine 扫描**：`/api/tags` (`GET`/`POST`/`DELETE`)、`POST /api/file_tags`、`/api/favorites`、`GET /api/recent`、`POST /api/search`、`POST /api/duplicates`（先按字节大小分组再算 MD5 哈希）、`POST /api/spine_scan`。
- **OpenAI 兼容 AI 助手**：`POST /api/ai/test`、`POST /api/ai/suggest_name`、`POST /api/ai/describe`、`POST /api/ai/organize_suggest`，以及 WebSocket 批量重命名事件 `ai_batch_rename` / `ai_cancel`（实时推送 `ai_progress` 与 `ai_result_item`）。

---

## 4. 启动、安装与调试方法

### 4.1 常规启动
```powershell
# 方式 1：双击或命令行运行批处理
.\run.bat

# 方式 2：直接用 Python 启动（server.py 内置 _ensure_deps 会自动 pip install 缺失包）
python server.py
```
启动后服务监听 `http://127.0.0.1:7870`，并在 1.5 秒后自动打开浏览器。

### 4.2 后台重启与端口检查（开发调试推荐）
修改 `server.py` 后，可在仓库根目录执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\_restart.ps1
```
该脚本会终止旧 `python` 进程、在后台启动 `server.py`，将标准输出/错误写入 `_s.log` 与 `_s.err`，并验证 `7870` 端口是否处于 `Listen` 状态。
> **注意**：`_restart.ps1` 中 `Get-Process python | Stop-Process -Force` 会停止本机所有名为 `python` 的进程。若宿主机同时跑有 ComfyUI 或其他 Python 服务，请勿直接跑 `_restart.ps1`，应按端口 `7870` 查杀对应 PID：
> ```powershell
> $conn = Get-NetTCPConnection -LocalPort 7870 -State Listen -ErrorAction SilentlyContinue
> if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
> ```

---

## 5. 开发约束与安全红线

1. **前后端分类字典同步约束**：
   - `server.py` 中的 `FILE_CATEGORIES` 与 `static/app.js` 顶部的 `FILE_CATEGORIES` 共同决定归档分类展示与目录落盘。新增或修改分类 ID、目录名（如 `_底图`、`_切图素材`）时，**必须同步检查前后端两处定义**。
2. **文件移动/重命名的数据一致性**：
   - 任何修改文件路径的操作（含 `rename`、`move` 及其 `undo`），必须同步执行 SQLite 更新：`UPDATE file_tags / favorites / ai_meta SET file_path=? WHERE file_path=?`，防止标签、收藏和 AI 描述丢失。
3. **安全删除原则**：
   - 删除操作默认必须走 `send2trash.send2trash()` 进入操作系统回收站；任何自动清理或批量整理逻辑严禁静默调用 `os.remove` / `shutil.rmtree` 物理删除用户美术资产。
4. **Windows 控制台编码与路径规范**：
   - Windows 控制台默认 GBK，打印含 Emoji 或特殊字符的日志容易触发 `UnicodeEncodeError`，需保持 `main()` 中的 `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`。
   - 跨平台/Windows 路径入参统一先经过 `normalize_path()` 处理。
5. **严禁提交敏感信息与运行时产物**：
   - 严禁将真实的 OpenAI / DeepSeek / 智谱 API Key 或内网私有凭据硬编码或写入 `_data/config.json` 后提交 Git。
   - `_data/lingxi.db`、`_data/thumbs/`、`*.log`、`*.err` 等运行时产物必须保持被 `.gitignore` 忽略，提交前务必执行 `git status` 与 `git diff --cached` 核查。
