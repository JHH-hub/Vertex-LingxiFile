#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
灵犀文件管家 - Web 版后端
Flask + SocketIO + SQLite
作者：AI 辅助生成
"""

import os
import sys
import json
import time
import base64
import shutil
import hashlib
import sqlite3
import threading
import subprocess
import mimetypes
import webbrowser
from pathlib import Path
from io import BytesIO
from datetime import datetime
from urllib.parse import quote, unquote

# ---- 自动安装缺失依赖 ----
def _ensure_deps():
    required = {
        'PIL': 'Pillow',
        'flask': 'flask',
        'flask_socketio': 'flask-socketio',
        'requests': 'requests',
        'send2trash': 'send2trash',
    }
    missing = []
    for mod, pkg in required.items():
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"[自动安装] 缺失依赖: {', '.join(missing)}")
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q'] + missing)

_ensure_deps()

from PIL import Image
from flask import Flask, render_template, request, jsonify, send_file, Response, abort
from flask_socketio import SocketIO
import requests
import send2trash

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, '_data')
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'lingxi.db')
CONFIG_PATH = os.path.join(DATA_DIR, 'config.json')
THUMB_CACHE = os.path.join(DATA_DIR, 'thumbs')
os.makedirs(THUMB_CACHE, exist_ok=True)

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['SECRET_KEY'] = 'lingxi-file-2026'
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024 * 1024
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 静态资源禁用浏览器缓存，避免老版本 UI 一直被 304 命中
@app.after_request
def _no_cache_static(resp):
    try:
        if request.path.startswith('/static/'):
            resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
    except Exception:
        pass
    return resp

# ============ 配置管理 ============

DEFAULT_CONFIG = {
    "roots": [],  # 根目录列表，如 [{"name":"游戏项目","path":"F:\\05 中式微恐（游戏项目）"}]
    "projects": [],  # 游戏项目列表 [{"id":"uuid", "name":"中式微恐", "path":"F:\\05 中式微恐", "type":"zhaocha|pintu|other", "status":"dev|test|online"}]
    "ai": {
        "provider": "openai",
        "api_base": "https://api.openai.com/v1",
        "api_key": "",
        "model": "gpt-4o-mini",
        "vision_model": "gpt-4o-mini",
        "enabled": False
    },
    "rename_template": "{语义名}",
    "theme": "dark"
}

def load_config():
    if not os.path.exists(CONFIG_PATH):
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        # 补全缺失字段
        for k, v in DEFAULT_CONFIG.items():
            if k not in cfg:
                cfg[k] = v
            elif isinstance(v, dict):
                for sk, sv in v.items():
                    if sk not in cfg[k]:
                        cfg[k][sk] = sv
        return cfg
    except Exception:
        return DEFAULT_CONFIG.copy()

def save_config(cfg):
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ============ 数据库 ============

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # 标签表
    c.execute('''CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#6c5ce7',
        created_at REAL
    )''')
    # 文件-标签关联
    c.execute('''CREATE TABLE IF NOT EXISTS file_tags (
        file_path TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (file_path, tag_id)
    )''')
    # 收藏
    c.execute('''CREATE TABLE IF NOT EXISTS favorites (
        file_path TEXT PRIMARY KEY,
        name TEXT,
        added_at REAL
    )''')
    # 操作历史（用于撤销）
    c.execute('''CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        src TEXT,
        dst TEXT,
        batch_id TEXT,
        meta TEXT,
        created_at REAL,
        undone INTEGER DEFAULT 0
    )''')
    c.execute('CREATE INDEX IF NOT EXISTS idx_history_batch ON history(batch_id)')
    # 文件AI元数据缓存（描述、摘要、自动标签）
    c.execute('''CREATE TABLE IF NOT EXISTS ai_meta (
        file_path TEXT PRIMARY KEY,
        file_hash TEXT,
        description TEXT,
        auto_tags TEXT,
        updated_at REAL
    )''')
    # 最近访问
    c.execute('''CREATE TABLE IF NOT EXISTS recent (
        file_path TEXT PRIMARY KEY,
        accessed_at REAL
    )''')
    conn.commit()
    conn.close()

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

init_db()

# ============ 文件类型识别 ============

IMG_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tga', '.ico'}
VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.flv', '.webm', '.wmv'}
AUDIO_EXTS = {'.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'}
TEXT_EXTS = {'.txt', '.md', '.log', '.csv', '.ini', '.cfg', '.yaml', '.yml'}
CODE_EXTS = {'.py', '.js', '.ts', '.html', '.css', '.json', '.xml', '.c', '.cpp', '.h', '.java', '.go', '.rs', '.sh', '.bat', '.lua', '.cs'}
DOC_EXTS = {'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'}
ARCHIVE_EXTS = {'.zip', '.rar', '.7z', '.tar', '.gz'}
DESIGN_EXTS = {'.psd', '.ai', '.sketch', '.xd', '.fig'}
GAME_EXTS = {'.spine', '.atlas', '.skel', '.fbx', '.obj', '.blend', '.prefab', '.unity', '.anim'}

def get_file_kind(path):
    """返回文件类别，用于图标和分组"""
    ext = Path(path).suffix.lower()
    if ext in IMG_EXTS: return 'image'
    if ext in VIDEO_EXTS: return 'video'
    if ext in AUDIO_EXTS: return 'audio'
    if ext in TEXT_EXTS: return 'text'
    if ext in CODE_EXTS: return 'code'
    if ext in DOC_EXTS: return 'document'
    if ext in ARCHIVE_EXTS: return 'archive'
    if ext in DESIGN_EXTS: return 'design'
    if ext in GAME_EXTS: return 'game'
    return 'other'

def is_previewable_image(path):
    return Path(path).suffix.lower() in IMG_EXTS

def human_size(n):
    for unit in ['B','KB','MB','GB','TB']:
        if n < 1024: return f"{n:.1f} {unit}" if unit != 'B' else f"{n} B"
        n /= 1024
    return f"{n:.1f} PB"

# ============ 缩略图 ============

def get_thumb_path(file_path, size=256):
    """获取缩略图缓存路径"""
    h = hashlib.md5(f"{file_path}|{size}|{os.path.getmtime(file_path) if os.path.exists(file_path) else 0}".encode('utf-8')).hexdigest()
    return os.path.join(THUMB_CACHE, f"{h}_{size}.jpg")

def make_thumb(file_path, size=256):
    """生成图片缩略图（仅图片）"""
    ext = Path(file_path).suffix.lower()
    if ext not in IMG_EXTS:
        return None
    cache = get_thumb_path(file_path, size)
    if os.path.exists(cache):
        return cache
    try:
        img = Image.open(file_path)
        img.thumbnail((size, size), Image.LANCZOS)
        if img.mode in ('RGBA', 'LA', 'P'):
            bg = Image.new('RGB', img.size, (30, 30, 37))
            if img.mode == 'P':
                img = img.convert('RGBA')
            bg.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
            img = bg
        else:
            img = img.convert('RGB')
        img.save(cache, 'JPEG', quality=82)
        return cache
    except Exception as e:
        return None

# ============ 路径安全 ============

def normalize_path(p):
    """统一路径格式"""
    if not p:
        return ''
    try:
        return os.path.normpath(p)
    except Exception:
        return p

def path_in_roots(path):
    """确认路径在配置的根目录之内（可选的安全检查，目前仅警告）"""
    cfg = load_config()
    path = normalize_path(path)
    if not cfg['roots']:
        return True  # 未设置时允许全盘
    for r in cfg['roots']:
        root = normalize_path(r['path'])
        try:
            if os.path.commonpath([path, root]) == root:
                return True
        except Exception:
            continue
    return True  # 宽松模式，不做强制

# ============ 路由：基础页面 ============

@app.route('/')
def index():
    return render_template('index.html')

# ============ 路由：配置 ============

@app.route('/api/config', methods=['GET'])
def api_get_config():
    cfg = load_config()
    # 返回时隐藏 api_key 具体内容，只返回是否配置
    safe = json.loads(json.dumps(cfg))
    if safe.get('ai', {}).get('api_key'):
        safe['ai']['api_key_set'] = True
        safe['ai']['api_key'] = '****' + safe['ai']['api_key'][-4:] if len(safe['ai']['api_key']) > 4 else '****'
    else:
        safe['ai']['api_key_set'] = False
    return jsonify(safe)

@app.route('/api/config', methods=['POST'])
def api_save_config():
    data = request.json
    cfg = load_config()
    # 合并更新
    if 'roots' in data:
        cfg['roots'] = data['roots']
    if 'projects' in data:
        cfg['projects'] = data['projects']
    if 'ai' in data:
        for k, v in data['ai'].items():
            if k == 'api_key' and v and v.startswith('****'):
                continue  # 掩码回传，不覆盖
            cfg['ai'][k] = v
    if 'rename_template' in data:
        cfg['rename_template'] = data['rename_template']
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/api/ai/test', methods=['POST'])
def api_test_ai():
    """测试 AI 连接"""
    cfg = load_config()
    ai = cfg['ai']
    if not ai.get('api_key'):
        return jsonify({'ok': False, 'error': '未配置 API Key'}), 400
    try:
        r = requests.post(
            f"{ai['api_base'].rstrip('/')}/chat/completions",
            headers={'Authorization': f"Bearer {ai['api_key']}", 'Content-Type': 'application/json'},
            json={
                'model': ai['model'],
                'messages': [{'role': 'user', 'content': '回复一个字：好'}],
                'max_tokens': 10
            },
            timeout=15
        )
        if r.status_code == 200:
            content = r.json()['choices'][0]['message']['content']
            return jsonify({'ok': True, 'reply': content})
        return jsonify({'ok': False, 'error': f'HTTP {r.status_code}: {r.text[:200]}'}), 400
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 400

# ============ 路由：驱动器/根目录 ============

@app.route('/api/drives', methods=['GET'])
def api_drives():
    drives = []
    if sys.platform == 'win32':
        import string
        for letter in string.ascii_uppercase:
            d = f'{letter}:\\'
            if os.path.exists(d):
                drives.append({'name': d, 'path': d})
    else:
        drives = [{'name': '/', 'path': '/'}]
    cfg = load_config()
    return jsonify({'drives': drives, 'roots': cfg.get('roots', [])})

# ============ 路由：文件浏览 ============

@app.route('/api/list', methods=['POST'])
def api_list():
    """列出目录内容"""
    data = request.json or {}
    path = data.get('path', '')
    show_hidden = data.get('show_hidden', False)
    sort_by = data.get('sort_by', 'name')  # name / size / mtime / kind
    sort_desc = data.get('sort_desc', False)

    if not path:
        # 返回根目录列表
        cfg = load_config()
        return jsonify({
            'path': '',
            'is_root': True,
            'items': [],
            'breadcrumb': [],
            'roots': cfg.get('roots', [])
        })

    path = normalize_path(path)
    if not os.path.exists(path):
        return jsonify({'error': f'路径不存在: {path}'}), 404
    if not os.path.isdir(path):
        return jsonify({'error': f'非目录: {path}'}), 400

    items = []
    try:
        for entry in os.scandir(path):
            if not show_hidden and entry.name.startswith('.'):
                continue
            try:
                stat = entry.stat()
                kind = 'folder' if entry.is_dir() else get_file_kind(entry.path)
                items.append({
                    'name': entry.name,
                    'path': entry.path,
                    'is_dir': entry.is_dir(),
                    'size': 0 if entry.is_dir() else stat.st_size,
                    'size_human': '' if entry.is_dir() else human_size(stat.st_size),
                    'mtime': stat.st_mtime,
                    'mtime_human': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                    'kind': kind,
                    'ext': Path(entry.name).suffix.lower()
                })
            except (PermissionError, OSError):
                continue
    except PermissionError:
        return jsonify({'error': '无权限访问'}), 403

    # 排序
    keymap = {
        'name': lambda x: (not x['is_dir'], x['name'].lower()),
        'size': lambda x: (not x['is_dir'], x['size']),
        'mtime': lambda x: (not x['is_dir'], x['mtime']),
        'kind': lambda x: (not x['is_dir'], x['kind'], x['name'].lower())
    }
    # 先按 is_dir 分组，目录始终在前；内部按所选字段排序
    dirs = [i for i in items if i['is_dir']]
    files = [i for i in items if not i['is_dir']]
    key_only = {
        'name': lambda x: x['name'].lower(),
        'size': lambda x: x['size'],
        'mtime': lambda x: x['mtime'],
        'kind': lambda x: (x['kind'], x['name'].lower())
    }
    key_fn = key_only.get(sort_by, key_only['name'])
    dirs.sort(key=key_fn, reverse=sort_desc)
    files.sort(key=key_fn, reverse=sort_desc)
    items = dirs + files

    # 面包屑
    breadcrumb = []
    p = Path(path)
    parts = list(p.parts)
    acc = ''
    for part in parts:
        acc = os.path.join(acc, part) if acc else part
        breadcrumb.append({'name': part, 'path': acc})

    # 批量查询标签和收藏
    conn = db()
    paths = [i['path'] for i in items]
    if paths:
        placeholders = ','.join('?' * len(paths))
        # 标签
        rows = conn.execute(
            f"SELECT ft.file_path, t.id, t.name, t.color FROM file_tags ft JOIN tags t ON ft.tag_id=t.id WHERE ft.file_path IN ({placeholders})",
            paths
        ).fetchall()
        tag_map = {}
        for r in rows:
            tag_map.setdefault(r['file_path'], []).append({'id': r['id'], 'name': r['name'], 'color': r['color']})
        # 收藏
        fav_rows = conn.execute(
            f"SELECT file_path FROM favorites WHERE file_path IN ({placeholders})",
            paths
        ).fetchall()
        fav_set = {r['file_path'] for r in fav_rows}
        # AI元数据
        ai_rows = conn.execute(
            f"SELECT file_path, description FROM ai_meta WHERE file_path IN ({placeholders})",
            paths
        ).fetchall()
        ai_map = {r['file_path']: r['description'] for r in ai_rows}
        for i in items:
            i['tags'] = tag_map.get(i['path'], [])
            i['favorite'] = i['path'] in fav_set
            i['ai_desc'] = ai_map.get(i['path'], '')
    conn.close()

    return jsonify({
        'path': path,
        'is_root': False,
        'items': items,
        'breadcrumb': breadcrumb,
        'count': len(items)
    })

@app.route('/api/tree', methods=['POST'])
def api_tree():
    """获取目录树（仅目录，延迟加载）"""
    data = request.json or {}
    path = data.get('path', '')
    depth = data.get('depth', 1)

    def walk(p, d):
        try:
            nodes = []
            for entry in os.scandir(p):
                if entry.is_dir() and not entry.name.startswith('.'):
                    node = {
                        'name': entry.name,
                        'path': entry.path,
                        'children': []
                    }
                    if d > 1:
                        node['children'] = walk(entry.path, d - 1)
                    else:
                        # 检测是否有子目录
                        try:
                            has_sub = any(e.is_dir() for e in os.scandir(entry.path))
                            node['has_children'] = has_sub
                        except Exception:
                            node['has_children'] = False
                    nodes.append(node)
            nodes.sort(key=lambda x: x['name'].lower())
            return nodes
        except (PermissionError, OSError):
            return []

    if not path:
        return jsonify({'nodes': []})
    return jsonify({'nodes': walk(path, depth)})

# ============ 路由：缩略图 & 预览 ============

@app.route('/api/thumb')
def api_thumb():
    path = request.args.get('path', '')
    size = int(request.args.get('size', 256))
    path = normalize_path(unquote(path))
    if not os.path.exists(path) or not os.path.isfile(path):
        abort(404)
    thumb = make_thumb(path, size)
    if thumb and os.path.exists(thumb):
        return send_file(thumb, mimetype='image/jpeg')
    abort(404)

@app.route('/api/raw')
def api_raw():
    """直接返回文件（用于大图预览/视频/下载）"""
    path = request.args.get('path', '')
    path = normalize_path(unquote(path))
    if not os.path.exists(path) or not os.path.isfile(path):
        abort(404)
    # 记录访问
    try:
        conn = db()
        conn.execute("INSERT OR REPLACE INTO recent (file_path, accessed_at) VALUES (?, ?)",
                     (path, time.time()))
        conn.commit()
        conn.close()
    except Exception:
        pass
    # 自动识别 mime
    mime, _ = mimetypes.guess_type(path)
    if mime is None:
        mime = 'application/octet-stream'
    return send_file(path, mimetype=mime)

@app.route('/api/preview_text', methods=['POST'])
def api_preview_text():
    data = request.json
    path = normalize_path(data.get('path', ''))
    max_bytes = int(data.get('max_bytes', 200000))
    if not os.path.exists(path) or not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 404
    size = os.path.getsize(path)
    try:
        with open(path, 'rb') as f:
            raw = f.read(max_bytes)
        # 自动解码
        text = None
        for enc in ['utf-8', 'gbk', 'gb2312', 'latin-1']:
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            text = raw.decode('utf-8', errors='replace')
        truncated = size > max_bytes
        return jsonify({'content': text, 'size': size, 'truncated': truncated})
    except Exception as e:
        return jsonify({'error': str(e)}), 400

# ============ 路由：文件操作 ============

def _log_history(action, src='', dst='', batch_id='', meta=None):
    conn = db()
    conn.execute(
        "INSERT INTO history (action, src, dst, batch_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (action, src, dst, batch_id, json.dumps(meta or {}, ensure_ascii=False), time.time())
    )
    conn.commit()
    conn.close()

def _unique_path(dst):
    """如果目标已存在，生成 xxx (2).ext 这样的不重复路径"""
    if not os.path.exists(dst):
        return dst
    p = Path(dst)
    stem, suffix = p.stem, p.suffix
    parent = p.parent
    i = 2
    while True:
        new = parent / f"{stem} ({i}){suffix}"
        if not new.exists():
            return str(new)
        i += 1

@app.route('/api/rename', methods=['POST'])
def api_rename():
    data = request.json
    src = normalize_path(data.get('src', ''))
    new_name = data.get('new_name', '').strip()
    if not src or not os.path.exists(src):
        return jsonify({'error': '源文件不存在'}), 404
    if not new_name or '/' in new_name or '\\' in new_name:
        return jsonify({'error': '名称非法'}), 400
    dst = os.path.join(os.path.dirname(src), new_name)
    if os.path.exists(dst) and os.path.normcase(dst) != os.path.normcase(src):
        return jsonify({'error': '目标名已存在'}), 409
    try:
        os.rename(src, dst)
        _log_history('rename', src, dst)
        # 迁移标签、收藏等数据库记录
        conn = db()
        conn.execute("UPDATE file_tags SET file_path=? WHERE file_path=?", (dst, src))
        conn.execute("UPDATE favorites SET file_path=? WHERE file_path=?", (dst, src))
        conn.execute("UPDATE ai_meta SET file_path=? WHERE file_path=?", (dst, src))
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'dst': dst})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/move', methods=['POST'])
def api_move():
    """移动文件/文件夹到指定目录"""
    data = request.json
    srcs = data.get('srcs', [])
    dst_dir = normalize_path(data.get('dst_dir', ''))
    if not os.path.isdir(dst_dir):
        return jsonify({'error': '目标目录不存在'}), 404
    batch_id = f"move_{int(time.time()*1000)}"
    results = []
    for src in srcs:
        src = normalize_path(src)
        if not os.path.exists(src):
            results.append({'src': src, 'ok': False, 'error': '不存在'})
            continue
        name = os.path.basename(src)
        dst = _unique_path(os.path.join(dst_dir, name))
        try:
            shutil.move(src, dst)
            _log_history('move', src, dst, batch_id)
            conn = db()
            conn.execute("UPDATE file_tags SET file_path=? WHERE file_path=?", (dst, src))
            conn.execute("UPDATE favorites SET file_path=? WHERE file_path=?", (dst, src))
            conn.execute("UPDATE ai_meta SET file_path=? WHERE file_path=?", (dst, src))
            conn.commit()
            conn.close()
            results.append({'src': src, 'dst': dst, 'ok': True})
        except Exception as e:
            results.append({'src': src, 'ok': False, 'error': str(e)})
    return jsonify({'batch_id': batch_id, 'results': results})

@app.route('/api/copy', methods=['POST'])
def api_copy():
    data = request.json
    srcs = data.get('srcs', [])
    dst_dir = normalize_path(data.get('dst_dir', ''))
    if not os.path.isdir(dst_dir):
        return jsonify({'error': '目标目录不存在'}), 404
    batch_id = f"copy_{int(time.time()*1000)}"
    results = []
    for src in srcs:
        src = normalize_path(src)
        if not os.path.exists(src):
            results.append({'src': src, 'ok': False, 'error': '不存在'})
            continue
        name = os.path.basename(src)
        dst = _unique_path(os.path.join(dst_dir, name))
        try:
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            _log_history('copy', src, dst, batch_id)
            results.append({'src': src, 'dst': dst, 'ok': True})
        except Exception as e:
            results.append({'src': src, 'ok': False, 'error': str(e)})
    return jsonify({'batch_id': batch_id, 'results': results})

@app.route('/api/delete', methods=['POST'])
def api_delete():
    """删除：默认移动到回收站（可恢复）"""
    data = request.json
    srcs = data.get('srcs', [])
    permanent = data.get('permanent', False)
    batch_id = f"delete_{int(time.time()*1000)}"
    results = []
    for src in srcs:
        src = normalize_path(src)
        if not os.path.exists(src):
            results.append({'src': src, 'ok': False, 'error': '不存在'})
            continue
        try:
            if permanent:
                if os.path.isdir(src):
                    shutil.rmtree(src)
                else:
                    os.remove(src)
                _log_history('delete_permanent', src, '', batch_id)
            else:
                send2trash.send2trash(src)
                _log_history('trash', src, '', batch_id)
            results.append({'src': src, 'ok': True})
        except Exception as e:
            results.append({'src': src, 'ok': False, 'error': str(e)})
    return jsonify({'batch_id': batch_id, 'results': results})

@app.route('/api/mkdir', methods=['POST'])
def api_mkdir():
    data = request.json
    parent = normalize_path(data.get('parent', ''))
    name = data.get('name', '').strip()
    if not os.path.isdir(parent):
        return jsonify({'error': '父目录不存在'}), 404
    if not name or '/' in name or '\\' in name:
        return jsonify({'error': '名称非法'}), 400
    dst = os.path.join(parent, name)
    if os.path.exists(dst):
        return jsonify({'error': '同名已存在'}), 409
    try:
        os.makedirs(dst)
        _log_history('mkdir', '', dst)
        return jsonify({'ok': True, 'path': dst})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/open_folder', methods=['POST'])
def api_open_folder():
    data = request.json
    folder = normalize_path(data.get('path', ''))
    if os.path.isdir(folder):
        if sys.platform == 'win32':
            os.startfile(folder)
        elif sys.platform == 'darwin':
            os.system(f'open "{folder}"')
        else:
            os.system(f'xdg-open "{folder}"')
        return jsonify({'ok': True})
    elif os.path.isfile(folder):
        # 在资源管理器中选中
        if sys.platform == 'win32':
            subprocess.run(['explorer', '/select,', folder])
        return jsonify({'ok': True})
    return jsonify({'error': '不存在'}), 404

@app.route('/api/open_file', methods=['POST'])
def api_open_file():
    """用系统默认程序打开文件"""
    data = request.json
    path = normalize_path(data.get('path', ''))
    if not os.path.exists(path):
        return jsonify({'error': '不存在'}), 404
    try:
        if sys.platform == 'win32':
            os.startfile(path)
        elif sys.platform == 'darwin':
            os.system(f'open "{path}"')
        else:
            os.system(f'xdg-open "{path}"')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============ 路由：历史 & 撤销 ============

@app.route('/api/history', methods=['GET'])
def api_history():
    limit = int(request.args.get('limit', 100))
    conn = db()
    rows = conn.execute(
        "SELECT * FROM history ORDER BY created_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return jsonify({
        'items': [dict(r) for r in rows]
    })

@app.route('/api/undo', methods=['POST'])
def api_undo():
    """撤销一条或一个批次的操作"""
    data = request.json
    history_id = data.get('id')
    batch_id = data.get('batch_id')
    conn = db()
    if batch_id:
        rows = conn.execute(
            "SELECT * FROM history WHERE batch_id=? AND undone=0 ORDER BY id DESC",
            (batch_id,)
        ).fetchall()
    elif history_id:
        rows = conn.execute(
            "SELECT * FROM history WHERE id=? AND undone=0",
            (history_id,)
        ).fetchall()
    else:
        conn.close()
        return jsonify({'error': '需要 id 或 batch_id'}), 400

    results = []
    for r in rows:
        action = r['action']
        src, dst = r['src'], r['dst']
        try:
            if action in ('rename', 'move'):
                if not os.path.exists(dst):
                    results.append({'id': r['id'], 'ok': False, 'error': '目标已不存在，无法撤销'})
                    continue
                # 撤销：把 dst 改回 src
                if src and os.path.dirname(src):
                    os.makedirs(os.path.dirname(src), exist_ok=True)
                shutil.move(dst, src)
                # 同步数据库（只在移动成功后执行）
                conn.execute("UPDATE file_tags SET file_path=? WHERE file_path=?", (src, dst))
                conn.execute("UPDATE favorites SET file_path=? WHERE file_path=?", (src, dst))
                conn.execute("UPDATE ai_meta SET file_path=? WHERE file_path=?", (src, dst))
            elif action == 'copy':
                if os.path.exists(dst):
                    if os.path.isdir(dst):
                        shutil.rmtree(dst)
                    else:
                        os.remove(dst)
            elif action == 'mkdir':
                if os.path.isdir(dst) and not os.listdir(dst):
                    os.rmdir(dst)
            elif action == 'trash':
                # 回收站的撤销较复杂，暂不支持自动恢复（需要用户手动从系统回收站恢复）
                results.append({'id': r['id'], 'ok': False, 'error': '请从系统回收站手动恢复'})
                continue
            conn.execute("UPDATE history SET undone=1 WHERE id=?", (r['id'],))
            results.append({'id': r['id'], 'ok': True})
        except Exception as e:
            results.append({'id': r['id'], 'ok': False, 'error': str(e)})
    conn.commit()
    conn.close()
    return jsonify({'results': results})

# ============ 路由：搜索 ============

@app.route('/api/search', methods=['POST'])
def api_search():
    """文件名搜索"""
    data = request.json
    query = data.get('query', '').strip().lower()
    root = normalize_path(data.get('root', ''))
    max_results = int(data.get('max_results', 500))
    kinds = data.get('kinds', [])  # 筛选类型
    if not query:
        return jsonify({'items': []})
    # 如果未指定根目录，使用配置的第一个根目录或全部根目录
    if not root or not os.path.isdir(root):
        cfg = load_config()
        roots = [r['path'] for r in cfg.get('roots', []) if os.path.isdir(r.get('path', ''))]
        if not roots:
            return jsonify({'error': '请先设置或选择一个搜索目录'}), 400
        # 多根目录时只搜第一个以免太慢；若用户想搜多根可在UI处扩展
        root = roots[0]

    results = []
    terms = [t for t in query.split() if t]

    def match(name):
        n = name.lower()
        return all(t in n for t in terms)

    try:
        dirs_set = set()
        for dirpath, dirnames, filenames in os.walk(root):
            # 跳过隐藏目录
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            # 用 (name, is_dir) 对避免同名文件/文件夹冲突
            entries = [(d, True) for d in dirnames] + [(f, False) for f in filenames]
            for fn, is_dir in entries:
                if match(fn):
                    full = os.path.join(dirpath, fn)
                    kind = 'folder' if is_dir else get_file_kind(full)
                    if kinds and kind not in kinds:
                        continue
                    try:
                        stat = os.stat(full)
                        results.append({
                            'name': fn,
                            'path': full,
                            'is_dir': is_dir,
                            'size': 0 if is_dir else stat.st_size,
                            'size_human': '' if is_dir else human_size(stat.st_size),
                            'mtime': stat.st_mtime,
                            'mtime_human': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                            'kind': kind,
                            'ext': Path(fn).suffix.lower(),
                            'parent': dirpath
                        })
                    except OSError:
                        continue
                    if len(results) >= max_results:
                        return jsonify({'items': results, 'truncated': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({'items': results, 'truncated': False})

# ============ 路由：标签 ============

@app.route('/api/tags', methods=['GET'])
def api_list_tags():
    conn = db()
    rows = conn.execute("SELECT t.*, COUNT(ft.file_path) as count FROM tags t LEFT JOIN file_tags ft ON t.id=ft.tag_id GROUP BY t.id ORDER BY t.name").fetchall()
    conn.close()
    return jsonify({'tags': [dict(r) for r in rows]})

@app.route('/api/tags', methods=['POST'])
def api_create_tag():
    data = request.json
    name = data.get('name', '').strip()
    color = data.get('color', '#6c5ce7')
    if not name:
        return jsonify({'error': '名称必填'}), 400
    conn = db()
    try:
        c = conn.execute("INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)", (name, color, time.time()))
        conn.commit()
        tid = c.lastrowid
        conn.close()
        return jsonify({'ok': True, 'id': tid, 'name': name, 'color': color})
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': '标签已存在'}), 409

@app.route('/api/tags/<int:tid>', methods=['DELETE'])
def api_delete_tag(tid):
    conn = db()
    conn.execute("DELETE FROM file_tags WHERE tag_id=?", (tid,))
    conn.execute("DELETE FROM tags WHERE id=?", (tid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/file_tags', methods=['POST'])
def api_set_file_tags():
    """为文件设置标签（覆盖）"""
    data = request.json
    path = normalize_path(data.get('path', ''))
    tag_ids = data.get('tag_ids', [])
    conn = db()
    conn.execute("DELETE FROM file_tags WHERE file_path=?", (path,))
    for tid in tag_ids:
        conn.execute("INSERT OR IGNORE INTO file_tags (file_path, tag_id) VALUES (?, ?)", (path, tid))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

# ============ 路由：收藏 ============

@app.route('/api/favorites', methods=['GET'])
def api_list_favorites():
    conn = db()
    rows = conn.execute("SELECT * FROM favorites ORDER BY added_at DESC").fetchall()
    conn.close()
    items = []
    for r in rows:
        p = r['file_path']
        exists = os.path.exists(p)
        items.append({
            'path': p,
            'name': r['name'],
            'added_at': r['added_at'],
            'exists': exists,
            'is_dir': os.path.isdir(p) if exists else False
        })
    return jsonify({'items': items})

@app.route('/api/favorites/toggle', methods=['POST'])
def api_toggle_favorite():
    data = request.json
    path = normalize_path(data.get('path', ''))
    conn = db()
    row = conn.execute("SELECT 1 FROM favorites WHERE file_path=?", (path,)).fetchone()
    if row:
        conn.execute("DELETE FROM favorites WHERE file_path=?", (path,))
        state = False
    else:
        conn.execute("INSERT INTO favorites (file_path, name, added_at) VALUES (?, ?, ?)",
                     (path, os.path.basename(path), time.time()))
        state = True
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'favorite': state})

# ============ 路由：最近访问 ============

@app.route('/api/recent', methods=['GET'])
def api_recent():
    limit = int(request.args.get('limit', 50))
    conn = db()
    rows = conn.execute("SELECT * FROM recent ORDER BY accessed_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    items = []
    for r in rows:
        p = r['file_path']
        if os.path.exists(p):
            items.append({
                'path': p,
                'name': os.path.basename(p),
                'accessed_at': r['accessed_at']
            })
    return jsonify({'items': items})

# ============ 路由：AI 功能 ============

def _ai_chat(messages, max_tokens=400, timeout=30):
    """调用 Chat API（OpenAI 兼容）"""
    cfg = load_config()
    ai = cfg['ai']
    if not ai.get('api_key'):
        raise RuntimeError('未配置 AI API Key，请先在设置中填写')
    r = requests.post(
        f"{ai['api_base'].rstrip('/')}/chat/completions",
        headers={'Authorization': f"Bearer {ai['api_key']}", 'Content-Type': 'application/json'},
        json={
            'model': ai['model'],
            'messages': messages,
            'max_tokens': max_tokens,
            'temperature': 0.3
        },
        timeout=timeout
    )
    if r.status_code != 200:
        raise RuntimeError(f"AI 调用失败 HTTP {r.status_code}: {r.text[:200]}")
    return r.json()['choices'][0]['message']['content']

def _ai_vision(image_path, prompt, max_tokens=300, timeout=45):
    """调用视觉 API（OpenAI 格式）"""
    cfg = load_config()
    ai = cfg['ai']
    if not ai.get('api_key'):
        raise RuntimeError('未配置 AI API Key')
    # 压缩到合适尺寸再传
    img = Image.open(image_path)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    img.thumbnail((1024, 1024), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, 'JPEG', quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode()

    r = requests.post(
        f"{ai['api_base'].rstrip('/')}/chat/completions",
        headers={'Authorization': f"Bearer {ai['api_key']}", 'Content-Type': 'application/json'},
        json={
            'model': ai.get('vision_model', ai['model']),
            'messages': [{
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': prompt},
                    {'type': 'image_url', 'image_url': {'url': f'data:image/jpeg;base64,{b64}'}}
                ]
            }],
            'max_tokens': max_tokens,
            'temperature': 0.3
        },
        timeout=timeout
    )
    if r.status_code != 200:
        raise RuntimeError(f"AI 视觉调用失败 HTTP {r.status_code}: {r.text[:200]}")
    return r.json()['choices'][0]['message']['content']

def _safe_filename(name):
    """移除非法字符"""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, '')
    name = name.strip().strip('.')
    return name[:100] if len(name) > 100 else name

def _ai_suggest_name_for_file(path, context_hint=''):
    """为单个文件生成推荐名，返回纯名称（不含扩展名）"""
    ext = Path(path).suffix
    base = Path(path).stem
    kind = get_file_kind(path)
    parent_name = os.path.basename(os.path.dirname(path))

    context = f"""
当前文件：{os.path.basename(path)}
所在目录：{parent_name}
文件类型：{kind}
文件扩展名：{ext}
{context_hint}
"""

    # 图片类：走视觉
    if kind == 'image':
        try:
            prompt = f"""这是一个游戏项目中的美术资源图片（当前文件名 {os.path.basename(path)}，所在目录「{parent_name}」）。

请根据图片内容给出一个简短、清晰、语义化的中文文件名（不含扩展名），规则：
1. 长度 3-12 个字
2. 能体现图片主体内容（比如：黑猫侧面、角色-阿姨-站立、背景-九公的家）
3. 尽量结合上下文目录名
4. 只返回最终的文件名，不要任何额外解释、引号或标点

示例输出：黑猫待机动作"""
            name = _ai_vision(path, prompt, max_tokens=60)
            name = name.strip().strip('"\'"').split('\n')[0]
            return _safe_filename(name)
        except Exception as e:
            raise RuntimeError(f"视觉模型调用失败: {e}")

    # 文本/代码类：读取内容摘要
    if kind in ('text', 'code'):
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read(3000)
            prompt = f"""{context}

文件内容前 3000 字符：
{content}

请根据内容为该文件取一个清晰的中文名（不含扩展名），长度3-12字，只返回文件名不要任何解释。"""
            name = _ai_chat([{'role': 'user', 'content': prompt}], max_tokens=60)
            name = name.strip().strip('"\'"').split('\n')[0]
            return _safe_filename(name)
        except Exception as e:
            raise RuntimeError(f"AI 调用失败: {e}")

    # 其他类型：基于文件名+目录名猜测
    try:
        prompt = f"""{context}

这是一个二进制文件，无法读取内容。请根据文件名、目录结构推测其用途，给出一个清晰的中文文件名（不含扩展名），长度3-12字。只返回文件名。"""
        name = _ai_chat([{'role': 'user', 'content': prompt}], max_tokens=60)
        name = name.strip().strip('"\'"').split('\n')[0]
        return _safe_filename(name)
    except Exception as e:
        raise RuntimeError(f"AI 调用失败: {e}")

@app.route('/api/ai/suggest_name', methods=['POST'])
def api_ai_suggest_name():
    """单个文件推荐名"""
    data = request.json
    path = normalize_path(data.get('path', ''))
    hint = data.get('hint', '')
    if not os.path.exists(path):
        return jsonify({'error': '文件不存在'}), 404
    try:
        name = _ai_suggest_name_for_file(path, hint)
        ext = Path(path).suffix
        suggest = f"{name}{ext}"
        return jsonify({'ok': True, 'suggest': suggest, 'name_only': name})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/ai/describe', methods=['POST'])
def api_ai_describe():
    """AI 描述文件内容（用于预览面板）"""
    data = request.json
    path = normalize_path(data.get('path', ''))
    if not os.path.exists(path):
        return jsonify({'error': '文件不存在'}), 404
    kind = get_file_kind(path)
    try:
        if kind == 'image':
            desc = _ai_vision(path, "请用简短的一两句中文描述这张图片的主要内容（50字以内），方便快速浏览。")
        elif kind in ('text', 'code'):
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read(3000)
            desc = _ai_chat([{'role': 'user', 'content': f"请用简短的一句中文总结这个文件的内容作用（50字以内）：\n\n{content}"}], max_tokens=120)
        else:
            return jsonify({'error': '该类型不支持 AI 描述'}), 400

        # 缓存
        conn = db()
        conn.execute(
            "INSERT OR REPLACE INTO ai_meta (file_path, description, updated_at) VALUES (?, ?, ?)",
            (path, desc, time.time())
        )
        conn.commit()
        conn.close()
        return jsonify({'ok': True, 'description': desc})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/ai/organize_suggest', methods=['POST'])
def api_ai_organize():
    """让 AI 给出一个目录的整理建议（只建议，不执行）"""
    data = request.json
    path = normalize_path(data.get('path', ''))
    if not os.path.isdir(path):
        return jsonify({'error': '不是有效目录'}), 400
    # 收集目录下一层文件清单
    items = []
    try:
        for entry in os.scandir(path):
            if entry.name.startswith('.'):
                continue
            items.append({
                'name': entry.name,
                'is_dir': entry.is_dir(),
                'ext': Path(entry.name).suffix.lower()
            })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    if not items:
        return jsonify({'ok': True, 'suggestions': [], 'message': '目录为空'})

    file_list = '\n'.join([f"{'📁 ' if i['is_dir'] else '📄 '}{i['name']}" for i in items[:80]])
    prompt = f"""我有一个文件夹「{os.path.basename(path)}」，里面有以下文件和子目录：

{file_list}

请以 JSON 格式给出整理建议，将这些文件归类到若干子文件夹中。要求：
1. 类别命名要简洁、语义清晰（比如"角色立绘"、"背景图"、"Spine动画"、"切图"等）
2. 不要建议移动已经是文件夹的项（除非是可合并的冗余目录）
3. 原则上每个文件必须被分到一个分类
4. 最多建议 6 个分类

严格按以下 JSON 格式返回（不要任何解释文字）：
{{"categories": [
  {{"folder": "分类文件夹名", "reason": "分类原因（20字内）", "files": ["文件名1","文件名2"]}}
]}}"""

    try:
        reply = _ai_chat([{'role': 'user', 'content': prompt}], max_tokens=1500, timeout=60)
        # 尝试抽取 JSON
        start = reply.find('{')
        end = reply.rfind('}')
        if start < 0 or end < 0:
            return jsonify({'ok': False, 'error': 'AI 未返回有效 JSON', 'raw': reply}), 500
        plan = json.loads(reply[start:end+1])
        return jsonify({'ok': True, 'plan': plan, 'base': path})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

# ============ SocketIO：批量 AI 任务（带进度） ============

_ai_cancel_flags = {}

@socketio.on('ai_batch_rename')
def ws_ai_batch_rename(data):
    """批量 AI 重命名。data: {task_id, files:[path], rename:true|false(预览)}"""
    task_id = data.get('task_id', f"task_{int(time.time()*1000)}")
    files = data.get('files', [])
    apply_rename = data.get('apply', False)
    _ai_cancel_flags[task_id] = False

    def run():
        batch_id = f"ai_rename_{int(time.time()*1000)}"
        results = []
        total = len(files)
        for i, path in enumerate(files):
            if _ai_cancel_flags.get(task_id):
                socketio.emit('ai_progress', {'task_id': task_id, 'status': 'cancelled'})
                return
            path = normalize_path(path)
            socketio.emit('ai_progress', {
                'task_id': task_id,
                'current': i + 1,
                'total': total,
                'file': os.path.basename(path),
                'percent': round((i) / total * 100, 1)
            })
            if not os.path.exists(path):
                results.append({'path': path, 'ok': False, 'error': '文件不存在'})
                continue
            try:
                name_only = _ai_suggest_name_for_file(path)
                ext = Path(path).suffix
                suggest = f"{name_only}{ext}"
                new_path = os.path.join(os.path.dirname(path), suggest)
                # 避免冲突
                if os.path.normcase(new_path) != os.path.normcase(path):
                    new_path = _unique_path(new_path)
                item = {
                    'path': path,
                    'name': os.path.basename(path),
                    'suggest': os.path.basename(new_path),
                    'new_path': new_path,
                    'ok': True
                }
                if apply_rename and os.path.normcase(new_path) != os.path.normcase(path):
                    try:
                        os.rename(path, new_path)
                        _log_history('rename', path, new_path, batch_id)
                        # 数据库迁移
                        conn = db()
                        conn.execute("UPDATE file_tags SET file_path=? WHERE file_path=?", (new_path, path))
                        conn.execute("UPDATE favorites SET file_path=? WHERE file_path=?", (new_path, path))
                        conn.execute("UPDATE ai_meta SET file_path=? WHERE file_path=?", (new_path, path))
                        conn.commit()
                        conn.close()
                        item['renamed'] = True
                    except Exception as e:
                        item['renamed'] = False
                        item['rename_error'] = str(e)
                results.append(item)
                socketio.emit('ai_result_item', {'task_id': task_id, 'item': item})
            except Exception as e:
                results.append({'path': path, 'ok': False, 'error': str(e)})
                socketio.emit('ai_result_item', {
                    'task_id': task_id,
                    'item': {'path': path, 'ok': False, 'error': str(e), 'name': os.path.basename(path)}
                })
        socketio.emit('ai_progress', {
            'task_id': task_id,
            'current': total,
            'total': total,
            'percent': 100,
            'status': 'done',
            'batch_id': batch_id,
            'results': results
        })
        _ai_cancel_flags.pop(task_id, None)

    threading.Thread(target=run, daemon=True).start()

@socketio.on('ai_cancel')
def ws_ai_cancel(data):
    task_id = data.get('task_id', '')
    if task_id in _ai_cancel_flags:
        _ai_cancel_flags[task_id] = True

# ============ 重复文件检测 ============

@app.route('/api/duplicates', methods=['POST'])
def api_duplicates():
    """扫描目录内的重复文件（按 hash）"""
    data = request.json
    root = normalize_path(data.get('root', ''))
    min_size = int(data.get('min_size', 1024))  # 默认1KB以上
    if not os.path.isdir(root):
        return jsonify({'error': '目录无效'}), 400

    # 先按大小分组
    size_map = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            try:
                sz = os.path.getsize(full)
                if sz < min_size:
                    continue
                size_map.setdefault(sz, []).append(full)
            except OSError:
                continue

    # 只对同大小文件计算 hash
    dup_groups = []
    for sz, files in size_map.items():
        if len(files) < 2:
            continue
        hash_map = {}
        for f in files:
            try:
                h = hashlib.md5()
                with open(f, 'rb') as fh:
                    for chunk in iter(lambda: fh.read(65536), b''):
                        h.update(chunk)
                hash_map.setdefault(h.hexdigest(), []).append(f)
            except Exception:
                continue
        for h, paths in hash_map.items():
            if len(paths) >= 2:
                dup_groups.append({
                    'hash': h,
                    'size': sz,
                    'size_human': human_size(sz),
                    'files': [{'path': p, 'name': os.path.basename(p),
                               'mtime': os.path.getmtime(p)} for p in paths]
                })

    dup_groups.sort(key=lambda g: g['size'] * (len(g['files']) - 1), reverse=True)
    total_wasted = sum(g['size'] * (len(g['files']) - 1) for g in dup_groups)
    return jsonify({
        'groups': dup_groups,
        'total_groups': len(dup_groups),
        'wasted_bytes': total_wasted,
        'wasted_human': human_size(total_wasted)
    })

# ============ Spine 资源识别（游戏项目专用） ============

@app.route('/api/spine_scan', methods=['POST'])
def api_spine_scan():
    """扫描目录下的 Spine 动画资源组（.spine + 同名atlas/json/png）"""
    data = request.json
    root = normalize_path(data.get('root', ''))
    if not os.path.isdir(root):
        return jsonify({'error': '目录无效'}), 400

    groups = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        # spine 文件
        spine_files = [f for f in filenames if f.lower().endswith('.spine')]
        for sf in spine_files:
            group = {
                'name': Path(sf).stem,
                'dir': dirpath,
                'spine': os.path.join(dirpath, sf),
                'related': []
            }
            for related in filenames:
                if related == sf:
                    continue
                rext = Path(related).suffix.lower()
                if rext in {'.atlas', '.json', '.png', '.skel'}:
                    group['related'].append({
                        'name': related,
                        'path': os.path.join(dirpath, related),
                        'ext': rext
                    })
            # 检查同名导出目录（动画导出/skeleton系列）
            for d in dirnames:
                if '导出' in d or 'export' in d.lower():
                    group['export_dir'] = os.path.join(dirpath, d)
                    break
            groups.append(group)

    return jsonify({'groups': groups, 'count': len(groups)})


# ============ 游戏项目文件整理 ============

# 文件分类规则引擎
FILE_CATEGORIES = {
    'completion': {
        'name': '完成图',
        'icon': '\U0001f3a8',
        'folder': '_完成图',
        'desc': '效果图、最终版展示图'
    },
    'source': {
        'name': '工程文件',
        'icon': '\U0001f4d0',
        'folder': '_工程文件',
        'desc': 'PSD/Spine 等可编辑源文件'
    },
    'spine_export': {
        'name': '动画导出',
        'icon': '\U0001f4e6',
        'folder': '_动画导出',
        'desc': 'Spine 导出的 skeleton 三件套'
    },
    'cutout': {
        'name': '切图素材',
        'icon': '\u2702\ufe0f',
        'folder': '_切图素材',
        'desc': '给 Spine/程序用的切好的散图'
    },
    'icon_set': {
        'name': '收集栏图标',
        'icon': '\U0001f3c5',
        'folder': '_收集栏图标',
        'desc': 'icon_001~xxx 系列'
    },
    'background': {
        'name': '底图',
        'icon': '\U0001f5bc\ufe0f',
        'folder': '_底图',
        'desc': '关卡背景底图'
    },
    'process_ai': {
        'name': '过程-AI生图',
        'icon': '\U0001f916',
        'folder': '_过程文件/AI生图',
        'desc': '即梦/MJ/SD 等 AI 工具生成的图片'
    },
    'process_ref': {
        'name': '过程-参考截图',
        'icon': '\U0001f4f8',
        'folder': '_过程文件/参考截图',
        'desc': '企业微信截图、屏幕截图等'
    },
    'process_draft': {
        'name': '过程-草稿迭代',
        'icon': '\U0001f4dd',
        'folder': '_过程文件/草稿迭代',
        'desc': 'UUID 文件名、带版本号的迭代稿'
    },
    'package': {
        'name': '打包交付',
        'icon': '\U0001f4ee',
        'folder': '_打包交付',
        'desc': '打包好的 zip/rar 压缩文件'
    },
    'unknown': {
        'name': '未分类',
        'icon': '\u2753',
        'folder': None,
        'desc': '无法自动判断类别的文件'
    }
}

# UUID 文件名模式
import re
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)
CANVAS_NODE_PATTERN = re.compile(r'^canvas_node_(origin|generated)_', re.IGNORECASE)
JIMENG_PATTERN = re.compile(r'^jimeng-\d{4}-\d{2}-\d{2}-', re.IGNORECASE)
IMG_GEN_PATTERN = re.compile(r'^\u56fe\u7247\u751f\u6210-\d+', re.IGNORECASE)


def classify_file(filepath, filename, parent_dir_name=''):
    """根据规则判断单个文件的分类"""
    name_lower = filename.lower()
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()

    # 1. 工程文件：.psd, .spine
    if ext in {'.psd', '.psb', '.ai', '.sketch', '.xd', '.fig'}:
        return 'source'
    if ext == '.spine':
        return 'source'

    # 2. Spine 导出三件套：skeleton.atlas/json/png（在「导出」目录内）
    if stem.lower() == 'skeleton' and ext in {'.atlas', '.json', '.png', '.skel'}:
        return 'spine_export'

    # 3. 压缩包
    if ext in {'.zip', '.rar', '.7z', '.tar', '.gz'}:
        return 'package'

    # 4. 图标系列 icon_001 ~ icon_xxx
    if re.match(r'^icon_\d+', stem, re.IGNORECASE):
        return 'icon_set'

    # 5. 完成图/效果图
    completion_keywords = ['\u6548\u679c\u56fe', '\u5b8c\u6210\u56fe', '\u5b8c\u6210', '\u6700\u7ec8', 'final']
    for kw in completion_keywords:
        if kw in stem:
            return 'completion'

    # 6. 底图/背景图
    bg_keywords = ['\u5e95\u56fe', '\u80cc\u666f\u56fe', 'bg']
    if any(stem == kw or stem.startswith(kw) or stem.endswith(kw) for kw in bg_keywords):
        if ext in {'.png', '.jpg', '.jpeg'}:
            return 'background'

    # 7. AI 生图
    if JIMENG_PATTERN.match(filename):
        return 'process_ai'
    if IMG_GEN_PATTERN.match(filename):
        return 'process_ai'

    # 8. 参考截图
    screenshot_keywords = ['\u4f01\u4e1a\u5fae\u4fe1\u622a\u56fe', '\u5c4f\u5e55\u622a\u56fe', 'screenshot', '\u5fae\u4fe1\u56fe\u7247']
    for kw in screenshot_keywords:
        if kw in filename:
            return 'process_ref'

    # 9. UUID / canvas_node 文件名
    if UUID_PATTERN.match(filename):
        return 'process_draft'
    if CANVAS_NODE_PATTERN.match(filename):
        return 'process_draft'

    # 10. 带版本号后缀的图片
    if ext in {'.png', '.jpg', '.jpeg'} and re.search(r'\d+\s*$', stem):
        if '\u5207\u56fe' in parent_dir_name:
            return 'cutout'
        try:
            size = os.path.getsize(filepath)
            if size > 500 * 1024:
                return 'process_draft'
        except:
            pass

    # 11. 切图素材
    if ext in {'.png', '.jpg', '.jpeg'}:
        if '\u5207\u56fe' in parent_dir_name:
            return 'cutout'
        if stem.startswith('\u56fe\u5c42'):
            return 'cutout'
        try:
            size = os.path.getsize(filepath)
            if size < 200 * 1024:
                return 'cutout'
        except:
            pass

    return 'unknown'


def classify_directory(dirpath, dirname):
    """判断整个目录的分类"""
    name_lower = dirname.lower()

    export_keywords = ['\u5bfc\u51fa', 'export']
    for kw in export_keywords:
        if kw in name_lower:
            return 'spine_export'

    if '\u5207\u56fe' in name_lower:
        return 'cutout'

    if 'icon' in name_lower or '\u6536\u96c6\u680f' in name_lower:
        return 'icon_set'

    if '\u8fc7\u7a0b' in name_lower:
        return 'process_draft'

    if any(kw in name_lower for kw in ['\u4eba\u7269', '\u4eba\u5934', '\u89d2\u8272']):
        return 'cutout'

    return 'unknown'


@app.route('/api/organize/scan', methods=['POST'])
def api_organize_scan():
    """扫描一个关卡/项目目录，返回文件分类预览"""
    data = request.json
    raw_root = (data or {}).get('root', '')
    root = normalize_path(raw_root)
    # 诊断日志：前端 400 问题排查
    if not os.path.isdir(root):
        print(f'[organize_scan] BAD DIR: raw={raw_root!r}, normalized={root!r}, '
              f'exists={os.path.exists(root)}, isdir={os.path.isdir(root)}')
        return jsonify({'error': '\u76ee\u5f55\u65e0\u6548', 'path': root, 'raw': raw_root}), 400

    result = {
        'root': root,
        'categories': {},
        'stats': {
            'total_files': 0,
            'total_size': 0,
            'classified': 0,
            'unclassified': 0
        }
    }

    for cat_id in FILE_CATEGORIES:
        result['categories'][cat_id] = []

    # 扫描顶层文件
    for item in os.listdir(root):
        item_path = os.path.join(root, item)

        if os.path.isfile(item_path):
            cat = classify_file(item_path, item, os.path.basename(root))
            size = 0
            try:
                size = os.path.getsize(item_path)
            except:
                pass
            result['categories'][cat].append({
                'name': item,
                'path': item_path,
                'size': size,
                'size_human': human_size(size),
                'is_dir': False
            })
            result['stats']['total_files'] += 1
            result['stats']['total_size'] += size
            if cat != 'unknown':
                result['stats']['classified'] += 1
            else:
                result['stats']['unclassified'] += 1

        elif os.path.isdir(item_path):
            if item.startswith('_'):
                continue
            cat = classify_directory(item_path, item)
            dir_size = 0
            file_count = 0
            for dp, dn, fn in os.walk(item_path):
                for f in fn:
                    fp = os.path.join(dp, f)
                    try:
                        dir_size += os.path.getsize(fp)
                        file_count += 1
                    except:
                        pass
            result['categories'][cat].append({
                'name': item + '/',
                'path': item_path,
                'size': dir_size,
                'size_human': human_size(dir_size),
                'is_dir': True,
                'file_count': file_count
            })
            result['stats']['total_files'] += file_count
            result['stats']['total_size'] += dir_size
            if cat != 'unknown':
                result['stats']['classified'] += 1
            else:
                result['stats']['unclassified'] += 1

    # 扫描一级子目录中的过程文件
    for item in os.listdir(root):
        item_path = os.path.join(root, item)
        if os.path.isdir(item_path) and not item.startswith('_'):
            parent_cat = classify_directory(item_path, item)
            if parent_cat == 'process_draft':
                for sub_item in os.listdir(item_path):
                    sub_path = os.path.join(item_path, sub_item)
                    if os.path.isfile(sub_path):
                        sub_cat = classify_file(sub_path, sub_item, item)
                        if sub_cat not in ('process_ai', 'process_ref'):
                            sub_cat = 'process_draft'
                        size = 0
                        try:
                            size = os.path.getsize(sub_path)
                        except:
                            pass
                        result['categories'][sub_cat].append({
                            'name': f'{item}/{sub_item}',
                            'path': sub_path,
                            'size': size,
                            'size_human': human_size(size),
                            'is_dir': False,
                            'from_subdir': item
                        })

    result['stats']['total_size_human'] = human_size(result['stats']['total_size'])
    result['categories'] = {k: v for k, v in result['categories'].items() if v}
    return jsonify(result)


@app.route('/api/organize/execute', methods=['POST'])
def api_organize_execute():
    """执行文件整理：按照分类结果移动文件到对应目录"""
    data = request.json
    root = normalize_path(data.get('root', ''))
    moves = data.get('moves', [])
    if not os.path.isdir(root):
        return jsonify({'error': '\u76ee\u5f55\u65e0\u6548'}), 400
    if not moves:
        return jsonify({'error': '\u6ca1\u6709\u8981\u79fb\u52a8\u7684\u6587\u4ef6'}), 400

    # 项目/模块细分（最终落盘：<root>/_阶段/<project>_<module>/...）
    # module_name 是泛化后的"模块名"，可以是 关卡03 / 主页特效 / 通用UI / 加载页 等
    project_name = data.get('project_name') or ''
    module_name = data.get('module_name') or data.get('level_name') or ''

    # 兼容旧前端：若未传，则回退为 root 的父目录名做 <project>，root 自身目录名做 <module>
    if (not project_name) or (not module_name):
        try:
            root_base = os.path.basename(root)
            parent_guess = os.path.basename(os.path.dirname(root))
            project_name = project_name or parent_guess
            module_name = module_name or root_base
        except:
            pass
    # 兼容变量名
    level_name = module_name

    batch_id = f"organize_{int(time.time())}"
    results = {'moved': 0, 'failed': 0, 'errors': [], 'batch_id': batch_id}
    conn = db()

    for move in moves:
        src = normalize_path(move.get('path', ''))
        cat_id = move.get('category', 'unknown')

        if cat_id == 'unknown' or cat_id not in FILE_CATEGORIES:
            continue
        cat = FILE_CATEGORIES[cat_id]
        if not cat['folder']:
            continue

        target_dir = os.path.join(root, cat['folder'], f"{project_name}_{level_name}")
        os.makedirs(target_dir, exist_ok=True)

        basename = os.path.basename(src)
        dst = os.path.join(target_dir, basename)

        if os.path.exists(dst):
            stem_name = Path(basename).stem
            ext_name = Path(basename).suffix
            i = 1
            while os.path.exists(dst):
                dst = os.path.join(target_dir, f"{stem_name}_{i}{ext_name}")
                i += 1

        try:
            shutil.move(src, dst)
            conn.execute(
                'INSERT INTO history (action, src, dst, batch_id, created_at) VALUES (?, ?, ?, ?, ?)',
                ('organize_move', src, dst, batch_id, time.time())
            )
            results['moved'] += 1
        except Exception as e:
            results['failed'] += 1
            results['errors'].append({'file': basename, 'error': str(e)})

    conn.commit()
    conn.close()
    return jsonify(results)


@app.route('/api/organize/undo', methods=['POST'])
def api_organize_undo():
    """撤销一次整理操作"""
    data = request.json
    batch_id = data.get('batch_id', '')
    if not batch_id:
        return jsonify({'error': '\u7f3a\u5c11 batch_id'}), 400

    conn = db()
    rows = conn.execute(
        'SELECT id, src, dst FROM history WHERE batch_id=? AND undone=0 ORDER BY id DESC',
        (batch_id,)
    ).fetchall()

    reverted = 0
    for row in rows:
        src, dst = row['src'], row['dst']
        try:
            if os.path.exists(dst):
                os.makedirs(os.path.dirname(src), exist_ok=True)
                shutil.move(dst, src)
                conn.execute('UPDATE history SET undone=1 WHERE id=?', (row['id'],))
                reverted += 1
        except Exception:
            pass

    conn.commit()
    conn.close()
    return jsonify({'reverted': reverted, 'total': len(rows)})


@app.route('/api/organize/categories', methods=['GET'])
def api_organize_categories():
    """返回所有文件分类规则定义"""
    return jsonify(FILE_CATEGORIES)


# ============ Venus LLM 内网代理 ============

VENUS_TOKEN = 'DDqXI8Jegqb5jjvYtBbSFvfT@2187'
VENUS_URL   = 'http://v2.open.venus.oa.com/llmproxy/chat/completions'
VENUS_MODEL = 'hunyuan-turbo'


def _venus_chat(prompt, max_tokens=800, timeout=30, images=None):
    """调用腾讯内网 Venus LLM 代理

    :param prompt: 文本提示词
    :param images: 可选，[(name, image_path), ...]，会把图片以 base64 形式一并发送给 LLM（视觉理解）
    """
    content_parts = [{'type': 'text', 'text': prompt}]
    # 如果带图片，把它们压缩成 JPEG base64 附在消息里（供 hunyuan-turbo 等视觉模型识图）
    if images:
        for name, img_path in images:
            try:
                img = Image.open(img_path)
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                img.thumbnail((512, 512), Image.LANCZOS)
                buf = BytesIO()
                img.save(buf, 'JPEG', quality=70)
                b64 = base64.b64encode(buf.getvalue()).decode()
                content_parts.append({
                    'type': 'image_url',
                    'image_url': {'url': f'data:image/jpeg;base64,{b64}'}
                })
            except Exception as e:
                print(f'[venus] 图片编码失败 {name}: {e}')

    try:
        r = requests.post(
            VENUS_URL,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {VENUS_TOKEN}'
            },
            json={
                'model': VENUS_MODEL,
                'messages': [{'role': 'user', 'content': content_parts}],
                'max_tokens': max_tokens,
                'temperature': 0.2
            },
            timeout=timeout
        )
        if r.status_code != 200:
            raise RuntimeError(f'Venus HTTP {r.status_code}: {r.text[:200]}')
        content = r.json()['choices'][0]['message']['content']
        return content
    except requests.exceptions.Timeout:
        raise RuntimeError('Venus 请求超时，请检查内网连接')
    except requests.exceptions.ConnectionError:
        raise RuntimeError('Venus 连接失败，请确认已连接公司内网')


@app.route('/api/organize/llm_classify', methods=['POST'])
def api_organize_llm_classify():
    """用 LLM 对规则引擎无法识别的文件进行智能分类

    升级点（2026-04-30）：对图片文件，会直接把缩略图传给 LLM 做
    「视觉识别 + OCR」，这样能识别出画面里是「杯子/包/角色立绘/UI
    按钮/企业微信聊天记录截图」等具体内容，帮助判断该图应归入哪一类。
    """
    data = request.json
    files = data.get('files', [])  # [{name, path, size_human, is_dir}]
    root = data.get('root', '')
    root_name = os.path.basename(root) if root else ''

    if not files:
        return jsonify({'error': '没有需要分类的文件'}), 400

    # 构造分类目标列表
    cat_options = []
    for cid, cinfo in FILE_CATEGORIES.items():
        if cid == 'unknown':
            continue
        cat_options.append(f'- {cid}: {cinfo["name"]}（{cinfo["desc"]}）')
    cat_list_str = '\n'.join(cat_options)

    # 图片扩展名白名单（用于视觉识别）
    IMG_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}

    # 规则：限制视觉识别文件数量，防止超时（最多15张）
    # 非图片文件只走文件名
    image_files = []   # 需要视觉识别的图片
    text_only_files = []  # 仅文件名
    for f in files[:50]:
        name = f.get('name', '')
        path = f.get('path', '')
        ext = os.path.splitext(name)[1].lower()
        if (not f.get('is_dir')) and ext in IMG_EXTS and os.path.isfile(path) and len(image_files) < 15:
            image_files.append(f)
        else:
            text_only_files.append(f)

    results_all = []

    # ===== Step1: 纯文件名分类（批量一次调用） =====
    if text_only_files:
        file_list_str = '\n'.join([
            f'{"📁 " if f.get("is_dir") else "📄 "}{f["name"]}  ({f.get("size_human", "")})'
            for f in text_only_files
        ])

        prompt_text = f"""你是一个游戏美术项目的文件管理助手。以下文件来自目录「{root_name}」，请你根据文件名推测每个文件最可能属于哪个分类。

可选分类：
{cat_list_str}
- unknown: 未分类（确实无法判断时使用）

待分类文件：
{file_list_str}

请严格按以下 JSON 格式返回（不要任何解释文字）：
[
  {{"name": "文件名", "category": "分类ID", "reason": "简短理由(10字内)"}},
  ...
]

规则提示：
- 压缩包(zip/rar/7z) → package
- PSD/PSB/AI/.spine → source
- skeleton.atlas/json/png → spine_export
- 完全随机的名字/UUID → process_draft"""

        try:
            reply = _venus_chat(prompt_text, max_tokens=1500, timeout=30)
            match = re.search(r'\[[\s\S]*\]', reply)
            if match:
                parsed = json.loads(match.group())
                valid_cats = set(FILE_CATEGORIES.keys())
                for item in parsed:
                    if item.get('category') not in valid_cats:
                        item['category'] = 'unknown'
                    item['source'] = 'llm_text'
                results_all.extend(parsed)
        except Exception as e:
            print(f'[llm_classify] 文本分类失败: {e}')

    # ===== Step2: 图片文件走视觉识别（每张单独识别，准确率最高） =====
    for f in image_files:
        name = f.get('name', '')
        path = f.get('path', '')
        size_str = f.get('size_human', '')

        vision_prompt = f"""你是游戏美术项目的文件管理助手，擅长看图识别内容（含 OCR 文字识别）。

当前目录：{root_name}
文件名：{name}
文件大小：{size_str}

请先看图，识别图中主要内容（是什么物体/角色/场景/截图/AI生图界面），再判断它应该归入以下哪个分类：
{cat_list_str}
- unknown: 未分类

关键判断规则：
1. 如果图中有「即梦 / Midjourney / Stable Diffusion / DALL-E / ChatGPT 界面 / Discord 对话框」等 AI 生图工具界面特征 → process_ai
2. 如果图中有「企业微信 / 微信 / QQ / 网页浏览器 / IDE / 聊天记录 / 屏幕 UI」等截屏特征 → process_ref
3. 如果是**干净抠好的单个物件小图**（杯子、包、蜡烛、门、道具、角色局部），背景透明或纯色 → cutout
4. 如果是**完整场景背景图**（大面积渲染过的场景、没有前景角色/道具） → background
5. 如果是**最终效果展示图**（有完整构图、多元素组合、像宣传图/成品图） → completion
6. 如果是带版本号后缀的大图/草图 → process_draft
7. 如果是 icon_xxx 系列的小图标 → icon_set

请严格返回 JSON（只返回一个对象，不要数组、不要解释）：
{{"name": "{name}", "category": "分类ID", "reason": "看图识别结果（如：识别为杯子，应为切图），限25字内", "content": "画面内容简述（如：陶瓷杯/企微聊天截图/AI生图-即梦界面），限15字内"}}"""

        try:
            reply = _venus_chat(vision_prompt, max_tokens=300, timeout=25,
                                images=[(name, path)])
            start = reply.find('{')
            end = reply.rfind('}')
            if start >= 0 and end >= 0:
                item = json.loads(reply[start:end + 1])
                valid_cats = set(FILE_CATEGORIES.keys())
                if item.get('category') not in valid_cats:
                    item['category'] = 'unknown'
                item['name'] = name
                item['source'] = 'llm_vision'
                results_all.append(item)
            else:
                # 兜底：仅文件名判断
                results_all.append({
                    'name': name, 'category': 'unknown',
                    'reason': '视觉返回格式异常', 'source': 'llm_vision_fail'
                })
        except Exception as e:
            print(f'[llm_classify] 视觉识别失败 {name}: {e}')
            results_all.append({
                'name': name, 'category': 'unknown',
                'reason': f'视觉调用失败', 'source': 'llm_vision_fail'
            })

    return jsonify({'ok': True, 'results': results_all})


@app.route('/api/organize/detect_project', methods=['POST'])
def api_organize_detect_project():
    """自动识别项目名称：根据文件夹内容和结构推测项目名"""
    data = request.json
    root = normalize_path(data.get('root', ''))
    if not os.path.isdir(root):
        return jsonify({'error': '目录无效'}), 400

    dir_name = os.path.basename(root)
    parent_name = os.path.basename(os.path.dirname(root))

    # 收集目录下的文件名和子目录名
    items = []
    subdirs = []
    try:
        for entry in os.scandir(root):
            if entry.name.startswith('.') or entry.name.startswith('_'):
                continue
            if entry.is_dir():
                subdirs.append(entry.name)
            else:
                items.append(entry.name)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    # 收集同级目录（兄弟目录），可用于推测关卡编号体系
    siblings = []
    try:
        parent = os.path.dirname(root)
        for entry in os.scandir(parent):
            if entry.is_dir() and entry.name != dir_name and not entry.name.startswith('.'):
                siblings.append(entry.name)
    except Exception:
        pass

    file_sample = '\n'.join(items[:30])
    subdir_sample = '\n'.join(subdirs[:15])
    sibling_sample = '\n'.join(siblings[:15])

    prompt = f"""你是游戏美术项目的文件管理助手。请根据以下目录信息推测：
1. 项目名称（如：中式微恐、拼图小游戏）
2. 该目录属于项目下的哪种模块，并给出模块名称

模块类型 module_type 可选值：
- level: 关卡内容（包括 "关卡01"、"第一关"、"第3关-书房"、"level_01" 等）
- home: 主页 / 首页 / 开始页 / 主界面 / 主页特效
- common_ui: 项目通用 UI 设计（设置页、弹窗、按钮图标、UI套件等）
- loading: 加载页、过场动画
- other: 其他（如开场 CG、片头动画等非关卡项目级内容）

当前目录名：{dir_name}
上级目录名：{parent_name}
同级目录（兄弟文件夹）：
{sibling_sample or '（无）'}

当前目录下的子文件夹：
{subdir_sample or '（无）'}

当前目录下的文件（部分）：
{file_sample or '（无）'}

请严格返回 JSON（不要任何解释文字）：
{{
  "project_name": "项目名称",
  "module_type": "level/home/common_ui/loading/other 之一",
  "module_name": "模块名称（如：关卡03、主页特效、通用UI、加载页）",
  "level_name": "与 module_name 保持一致，向后兼容字段",
  "confidence": "high/medium/low",
  "reasoning": "简短推理过程(30字内)"
}}

判断提示：
- 目录名含「关卡/关/level/章/第x」→ module_type=level
- 目录名含「主页/首页/home/main/start」→ module_type=home
- 目录名含「UI/ui/界面/通用/common」且不是关卡内 → module_type=common_ui
- 目录名含「加载/loading/过场」→ module_type=loading
- 无法明确归类 → module_type=other"""

    try:
        reply = _venus_chat(prompt, max_tokens=400, timeout=20)
        start = reply.find('{')
        end = reply.rfind('}')
        if start < 0 or end < 0:
            return jsonify({'ok': False, 'error': 'LLM 返回格式异常', 'raw': reply[:200]}), 500

        result = json.loads(reply[start:end + 1])
        # 兼容性兜底：确保三个字段都存在
        if not result.get('module_name'):
            result['module_name'] = result.get('level_name', '') or dir_name
        if not result.get('level_name'):
            result['level_name'] = result['module_name']
        if not result.get('module_type'):
            result['module_type'] = 'level'
        return jsonify({'ok': True, **result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ============ 路由：项目工作台 ============

# 判断模块类型的关键字（与 detect_project LLM 的提示保持一致，但这里用规则推断，不调 LLM）
_MODULE_TYPE_KEYWORDS = {
    'home':       ['主页', '首页', 'home', 'main', 'start', '开始页'],
    'common_ui':  ['通用', '公共', 'common', 'ui套件', '界面套件', '控件'],
    'loading':    ['加载', 'loading', '过场', 'cg', '片头'],
}


def _guess_module_type(dir_name):
    """根据目录名猜测模块类型：level / home / common_ui / loading / other"""
    name_low = dir_name.lower()
    for mtype, keywords in _MODULE_TYPE_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in name_low:
                return mtype
    # 关卡关键字
    level_keywords = ['关卡', '关', 'level', '第', 'chapter', '章']
    for kw in level_keywords:
        if kw in dir_name or kw.lower() in name_low:
            return 'level'
    return 'other'


def _infer_archive_status(level_path):
    """推断一个关卡目录的归档进度，不做详细分类扫描，只看：
    - 已建好的 _分类子目录 是否存在且有文件 -> 算归档完成的分类
    - 整个关卡目录下的文件总数（含未归档的散文件）
    返回 {archived_categories: [...], total_categories, progress, file_count, archived_files}
    """
    archived = []
    total_cats = 0
    archived_files = 0
    # 1) 分类维度的进度
    for cat_id, cat_def in FILE_CATEGORIES.items():
        if cat_id == 'unknown' or not cat_def.get('folder'):
            continue
        total_cats += 1
        cat_folder = os.path.join(level_path, cat_def['folder'])
        if os.path.isdir(cat_folder):
            has_file = False
            cnt_here = 0
            try:
                for _dp, _dn, _fn in os.walk(cat_folder):
                    if _fn:
                        has_file = True
                        cnt_here += len(_fn)
            except Exception:
                pass
            if has_file:
                archived.append(cat_id)
                archived_files += cnt_here

    # 2) 整个关卡目录下的文件总数（包含未归档的散文件 + 已归档到 _xxx 子目录的文件）
    total_files = 0
    try:
        for _dp, _dn, _fn in os.walk(level_path):
            total_files += len(_fn)
    except Exception:
        pass

    progress = (len(archived) / total_cats) if total_cats > 0 else 0
    return {
        'archived_categories': archived,
        'total_categories': total_cats,
        'progress': round(progress, 3),
        'file_count': total_files,         # 关卡下全部文件数（用户关心的）
        'archived_files': archived_files,  # 其中已归档的文件数
    }


@app.route('/api/project/auto_discover', methods=['POST'])
def api_project_auto_discover():
    """自动发现磁盘上的"游戏项目"目录。
    扫描逻辑：
      - 对每个扫描根（默认：所有现存驱动器；可指定 scan_roots）
      - 列出一级子目录
      - 判断其是否"像游戏项目"：
          1. 名称中含"（游戏项目）""(游戏项目)""游戏"关键词
          2. 或子目录下存在 2 个以上"关卡/关/level/第N"命名的一级子目录
      - 返回候选列表，标记哪些已添加
    """
    data = request.json or {}
    scan_roots = data.get('scan_roots')  # 可选：前端指定要扫描的驱动器
    existing_paths = set()
    try:
        cfg = load_config()
        for p in (cfg.get('projects') or []):
            try:
                existing_paths.add(os.path.normpath(p.get('path', '')).lower())
            except Exception:
                pass
    except Exception:
        pass

    # 1) 确定扫描根列表
    if not scan_roots:
        scan_roots = []
        if sys.platform == 'win32':
            import string
            for letter in string.ascii_uppercase:
                d = f'{letter}:\\'
                if os.path.isdir(d):
                    scan_roots.append(d)
        else:
            scan_roots = ['/']

    # 2) 扫描每个根下的一级子目录作为候选
    candidates = []
    # 关键字判定
    project_keywords = ['（游戏项目）', '(游戏项目)', '游戏项目', '游戏']
    level_patterns = ['关卡', '第', 'level', 'chapter']
    # 跳过系统/常见无关目录
    skip_names = {'$recycle.bin', 'system volume information', 'windows', 'program files',
                  'program files (x86)', 'programdata', 'perflogs', '$windows.~bt',
                  '$windows.~ws', 'recovery', 'msocache', 'intel', 'appdata'}

    for root in scan_roots:
        try:
            entries = sorted(os.scandir(root), key=lambda e: e.name)
        except Exception:
            continue
        for entry in entries:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            name = entry.name
            name_low = name.lower()
            # 过滤系统目录、以 . 或 _ 开头
            if name.startswith('.') or name.startswith('_') or name.startswith('$'):
                continue
            if name_low in skip_names:
                continue

            reasons = []
            score = 0

            # 判定 1：目录名关键字
            for kw in project_keywords:
                if kw in name:
                    score += 3
                    reasons.append(f'名称含"{kw}"')
                    break

            # 判定 2：子目录下有多个"关卡"命名的目录
            level_count = 0
            subdir_names = []
            try:
                for sub in os.scandir(entry.path):
                    if not sub.is_dir(follow_symlinks=False):
                        continue
                    if sub.name.startswith('.') or sub.name.startswith('_'):
                        continue
                    subdir_names.append(sub.name)
                    for pat in level_patterns:
                        if pat in sub.name or pat in sub.name.lower():
                            level_count += 1
                            break
                    if len(subdir_names) > 50:  # 防止扫太多
                        break
            except Exception:
                pass

            if level_count >= 2:
                score += 3
                reasons.append(f'含 {level_count} 个关卡子目录')
            elif level_count >= 1:
                score += 1
                reasons.append(f'含 1 个关卡子目录')

            # 命中才保留
            if score <= 0:
                continue

            # 推断项目类型（基于常见关键词）
            ptype = 'other'
            if any(k in name for k in ('找茬', '找不同', '微恐', '虐渣', '霸总', '重开')):
                ptype = 'zhaocha'
            elif any(k in name for k in ('拼图', 'puzzle')):
                ptype = 'pintu'

            # 清理展示用的项目名（去掉"（游戏项目）"后缀、去掉前缀数字）
            display_name = name
            for kw in project_keywords:
                display_name = display_name.replace(kw, '')
            display_name = display_name.strip('（） ()-_ ')
            # 去掉开头的"01-"/"05 "这类编号
            import re
            display_name = re.sub(r'^\d+[-\s\.]*', '', display_name).strip()
            if not display_name:
                display_name = name

            exists_key = os.path.normpath(entry.path).lower()
            candidates.append({
                'name': display_name,
                'raw_name': name,
                'path': entry.path,
                'score': score,
                'reasons': reasons,
                'subdir_count': len(subdir_names),
                'level_like_count': level_count,
                'suggested_type': ptype,
                'already_added': exists_key in existing_paths,
            })

    # 按评分从高到低
    candidates.sort(key=lambda x: (-x['score'], x['name']))

    return jsonify({
        'ok': True,
        'scan_roots': scan_roots,
        'count': len(candidates),
        'candidates': candidates,
    })


@app.route('/api/project/create_level', methods=['POST'])
def api_project_create_level():
    """在项目根目录下创建新的关卡/模块目录。
    参数:
      root:        项目根目录
      name:        （可选）目录名；留空则自动跟随项目现有命名风格推断
      module_type: （可选）'level' / 'home' / 'common_ui' / 'loading' / 'other'
    """
    import re as _re
    data = request.json or {}
    root = normalize_path(data.get('root', ''))
    if not os.path.isdir(root):
        return jsonify({'ok': False, 'error': '项目根目录无效或不存在'}), 400

    name = (data.get('name') or '').strip()
    mtype = data.get('module_type') or 'level'

    # ---- 自动命名：跟随项目现有命名风格 ----
    if not name:
        if mtype == 'level':
            # 支持多种关卡命名格式，按优先级识别：
            #   "第N关"、"关卡NN"、"关N"、"level N"、"NN关"、"lv NN"
            # 统一提取：前缀、模板、最大编号
            patterns = [
                (_re.compile(r'^(?P<prefix>.*?)第(?P<num>\d+)关(?P<suffix>.*)$'), '{prefix}第{num}关'),
                (_re.compile(r'^(?P<prefix>.*?)关卡\s*0*(?P<num>\d+)(?P<suffix>.*)$'), '{prefix}关卡{num:02d}'),
                (_re.compile(r'^(?P<prefix>.*?)第(?P<num>\d+)章(?P<suffix>.*)$'), '{prefix}第{num}章'),
                (_re.compile(r'^(?P<prefix>.*?)(?:lv|level)\s*0*(?P<num>\d+)(?P<suffix>.*)$', _re.I), '{prefix}Level {num}'),
                (_re.compile(r'^(?P<prefix>.*?)(?P<num>\d+)关(?P<suffix>.*)$'), '{prefix}{num}关'),
            ]

            best_match = None  # (pattern_idx, max_num, sample_prefix)
            try:
                for e in os.scandir(root):
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    ename = e.name
                    if ename.startswith('.') or ename.startswith('_'):
                        continue
                    for idx, (pat, _) in enumerate(patterns):
                        m = pat.match(ename)
                        if m:
                            try:
                                num = int(m.group('num'))
                            except (ValueError, IndexError):
                                continue
                            prefix = m.group('prefix') or ''
                            if best_match is None or idx < best_match[0] or \
                               (idx == best_match[0] and num > best_match[1]):
                                best_match = (idx, num, prefix)
                            break
            except OSError:
                pass

            if best_match:
                pat_idx, max_num, prefix = best_match
                template = patterns[pat_idx][1]
                new_num = max_num + 1
                name = template.format(prefix=prefix, num=new_num)
            else:
                # 实在找不到任何现有关卡 —— 用默认格式
                name = '关卡01'
        elif mtype == 'home':
            name = '主页特效'
        elif mtype == 'common_ui':
            name = '通用UI'
        elif mtype == 'loading':
            name = '加载页'
        else:
            name = '新模块'

    # 名字中不能出现路径分隔符
    if '/' in name or '\\' in name or ':' in name:
        return jsonify({'ok': False, 'error': '名称不能包含 / \\ : 等字符'}), 400

    target = os.path.join(root, name)
    # 如果重名，自动在末尾加"(N)"直到唯一
    if os.path.exists(target):
        base_target = target
        for i in range(2, 100):
            candidate = f'{base_target} ({i})'
            if not os.path.exists(candidate):
                target = candidate
                name = f'{name} ({i})'
                break
        else:
            return jsonify({'ok': False, 'error': f'目录已存在：{name}'}), 400

    try:
        os.makedirs(target, exist_ok=False)
    except Exception as e:
        return jsonify({'ok': False, 'error': f'创建失败：{e}'}), 500

    archive_info = _infer_archive_status(target)
    return jsonify({
        'ok': True,
        'name': name,
        'path': target,
        'module_type': _guess_module_type(name),
        **archive_info,
    })


@app.route('/api/project/scan', methods=['POST'])
def api_project_scan():
    """扫描项目根目录：一级子目录视为"关卡"或"通用模块"，返回分组列表。
    不做文件分类扫描（快），仅推断归档进度。
    同时收集根目录下的散文件（没进任何子目录的"灯下黑"文件）。
    """
    data = request.json or {}
    root = normalize_path(data.get('root', ''))
    if not os.path.isdir(root):
        return jsonify({'ok': False, 'error': '项目根目录无效或不存在'}), 400

    levels = []          # 关卡
    common_modules = []  # 通用模块（主页/加载/通用UI/其他）
    loose_files = []     # 根目录下散落的文件（未归入任何关卡/模块）

    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    for entry in entries:
        name = entry.name
        try:
            if entry.is_dir(follow_symlinks=False):
                # 跳过以 . 或 _ 开头的目录（_分类目录 / 隐藏）
                if name.startswith('.') or name.startswith('_'):
                    continue
                mtype = _guess_module_type(name)
                archive_info = _infer_archive_status(entry.path)
                item = {
                    'name': name,
                    'path': entry.path,
                    'module_type': mtype,
                    **archive_info,
                }
                if mtype == 'level':
                    levels.append(item)
                else:
                    common_modules.append(item)
            elif entry.is_file(follow_symlinks=False):
                # 根目录下直接存在的文件 —— 需要提示用户整理
                if name.startswith('.') or name.startswith('~'):
                    continue
                try:
                    st = entry.stat()
                    size = st.st_size
                except OSError:
                    size = 0
                import re as _re
                loose_files.append({
                    'name': name,
                    'path': entry.path,
                    'size': size,
                    'size_human': human_size(size),
                    'is_image': bool(_re.search(r'\.(png|jpe?g|gif|webp|bmp|tiff?)$', name, _re.I)),
                })
        except OSError:
            continue

    return jsonify({
        'ok': True,
        'root': root,
        'levels': levels,
        'common_modules': common_modules,
        'loose_files': loose_files,
        'total': len(levels) + len(common_modules),
        'loose_count': len(loose_files),
    })


# ============ 启动 ============

def main():
    # Windows 控制台默认 GBK，对 emoji/部分中文会 UnicodeEncodeError 直接崩溃
    # 这里强制把 stdout/stderr 改为 UTF-8（Python 3.7+ 支持）
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    port = 7870
    url = f"http://127.0.0.1:{port}"
    print(f"\n{'='*60}")
    print(f"  🗂  灵犀文件管家 LingXi File Manager")
    print(f"  访问地址: {url}")
    print(f"  数据目录: {DATA_DIR}")
    print(f"{'='*60}\n")

    def open_browser():
        time.sleep(1.5)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()
    socketio.run(app, host='127.0.0.1', port=port, debug=False, allow_unsafe_werkzeug=True)

if __name__ == '__main__':
    main()
