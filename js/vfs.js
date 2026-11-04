/* vfs.js — 스크립트용 파일 시스템
 *  - 기본: 브라우저 localStorage 에 영구 저장되는 가상 파일 시스템(텍스트 파일)
 *  - 선택: "폴더 연결"(File System Access API, Chrome/Edge) 시 실제 PC 폴더와 동기화(write-through)
 *  - 스크립트의 io.open / io.lines / dofile / require 등이 이 계층을 사용한다 (동기 접근).
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const KEY = 'vscope.vfs.v1';

  function norm(name) {
    name = String(name).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const parts = [];
    for (const seg of name.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return parts.join('/');
  }

  class VFS {
    constructor() {
      this.files = new Map();
      this.listeners = [];
      this.dir = null;          // FileSystemDirectoryHandle (연결된 폴더)
      this.dirName = '';
      this._saveTimer = null;
      this._pendingDisk = new Map();
      this._diskBusy = false;
      this.load();
    }
    load() {
      const obj = VS.util.store.get(KEY, null);
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) this.files.set(k, String(obj[k]));
    }
    persist() {
      if (this._saveTimer) return;
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        const obj = {};
        for (const [k, v] of this.files) obj[k] = v;
        if (!VS.util.store.set(KEY, obj)) console.warn('VFS: localStorage 저장 실패(용량 초과 가능)');
      }, 300);
    }
    onChange(fn) { this.listeners.push(fn); }
    _changed(name) { for (const f of this.listeners) { try { f(name); } catch (e) { /* ignore */ } } }

    exists(name) { return this.files.has(norm(name)); }
    read(name) { const v = this.files.get(norm(name)); return v === undefined ? null : v; }
    write(name, content) {
      name = norm(name);
      if (!name) throw new Error('invalid file name');
      this.files.set(name, String(content));
      this.persist();
      this._toDisk(name);
      this._changed(name);
      return true;
    }
    remove(name) {
      name = norm(name);
      if (!this.files.has(name)) return false;
      this.files.delete(name);
      this.persist();
      this._removeDisk(name);
      this._changed(name);
      return true;
    }
    rename(a, b) {
      a = norm(a); b = norm(b);
      if (!this.files.has(a) || !b) return false;
      const v = this.files.get(a);
      this.files.delete(a); this.files.set(b, v);
      this.persist();
      this._removeDisk(a); this._toDisk(b);
      this._changed(b);
      return true;
    }
    list() { return Array.from(this.files.keys()).sort(); }
    size(name) { const v = this.read(name); return v == null ? 0 : v.length; }

    // ---------------- 실제 폴더 연결 (File System Access API) ----------------
    get canMount() { return typeof G.showDirectoryPicker === 'function'; }
    async mount() {
      if (!this.canMount) throw new Error('이 브라우저는 폴더 연결(File System Access API)을 지원하지 않습니다. Chrome/Edge 를 사용하세요.');
      const dir = await G.showDirectoryPicker({ mode: 'readwrite' });
      this.dir = dir; this.dirName = dir.name;
      await this.syncFromDisk();
      return dir.name;
    }
    unmount() { this.dir = null; this.dirName = ''; this._changed(null); }
    async syncFromDisk() {
      if (!this.dir) return 0;
      let n = 0;
      const walk = async (h, prefix, depth) => {
        for await (const [name, child] of h.entries()) {
          if (child.kind === 'file') {
            const file = await child.getFile();
            if (file.size > 4 * 1024 * 1024) continue; // 대용량 파일 제외
            const text = await file.text();
            this.files.set(norm(prefix + name), text); n++;
          } else if (child.kind === 'directory' && depth < 2 && !name.startsWith('.')) {
            await walk(child, prefix + name + '/', depth + 1);
          }
        }
      };
      await walk(this.dir, '', 0);
      this.persist();
      this._changed(null);
      return n;
    }
    async _fileHandle(name, create) {
      const parts = name.split('/');
      let d = this.dir;
      for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: create });
      return { dir: d, base: parts[parts.length - 1] };
    }
    _toDisk(name) {
      if (!this.dir) return;
      this._pendingDisk.set(name, 'w');
      this._pumpDisk();
    }
    _removeDisk(name) {
      if (!this.dir) return;
      this._pendingDisk.set(name, 'd');
      this._pumpDisk();
    }
    async _pumpDisk() {
      if (this._diskBusy) return;
      this._diskBusy = true;
      try {
        while (this._pendingDisk.size && this.dir) {
          const [name, op] = this._pendingDisk.entries().next().value;
          this._pendingDisk.delete(name);
          try {
            if (op === 'w') {
              const content = this.files.get(name);
              if (content === undefined) continue;
              const { dir, base } = await this._fileHandle(name, true);
              const fh = await dir.getFileHandle(base, { create: true });
              const w = await fh.createWritable();
              await w.write(content); await w.close();
            } else {
              const { dir, base } = await this._fileHandle(name, false);
              await dir.removeEntry(base);
            }
          } catch (e) { console.warn('VFS disk sync failed:', name, e); }
        }
      } finally { this._diskBusy = false; }
    }
  }

  VS.VFS = VFS;
  VS.vfsNorm = norm;
})(typeof window !== 'undefined' ? window : globalThis);
