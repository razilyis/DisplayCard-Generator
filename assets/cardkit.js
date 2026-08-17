/*!
 * CardKit — DisplayCard-Generator shared engine
 *
 * 各テーマ HTML が共通で使う「入力とプレビューの同期 / 配色スウォッチ / JSON 保存・読込 /
 * 印刷向け PNG 書き出し」をまとめたもの。
 *
 * 印刷ズレ対策の要点:
 *   1. 書き出しはプレビュー中のカード要素そのものを撮る。表示用の transform: scale() は
 *      撮影の直前だけ外し、レイアウトを一切いじらない（= プレビューと出力が完全一致）。
 *   2. 出力ピクセル数は「実寸 mm × DPI」から決め打ちする。ウィンドウ幅で変動しない。
 *   3. PNG に pHYs チャンク（物理解像度）を書き込む。これにより Illustrator / Word /
 *      プレビュー.app などが必ず 91×55mm として配置する。
 */
(function (global) {
    'use strict';

    var MM_PER_INCH = 25.4;
    var CSS_DPI = 96; // CSS の 1in = 96px 固定

    /* ------------------------------------------------------------------ *
     * 共通カラースウォッチ（DIC/CMYK 近似）
     * ------------------------------------------------------------------ */
    var CMYK_SWATCHES = [
        { hex: '#E60012', label: 'C:0 M:100 Y:100 K:0' }, { hex: '#F39800', label: 'C:0 M:60 Y:100 K:0' },
        { hex: '#FFF200', label: 'C:0 M:0 Y:100 K:0' }, { hex: '#8FC31F', label: 'C:50 M:0 Y:100 K:0' },
        { hex: '#009944', label: 'C:100 M:0 Y:100 K:0' }, { hex: '#00A1E9', label: 'C:100 M:0 Y:0 K:0' },
        { hex: '#0068B7', label: 'C:100 M:50 Y:0 K:0' }, { hex: '#1D2088', label: 'C:100 M:100 Y:0 K:0' },
        { hex: '#A100FF', label: 'C:50 M:100 Y:0 K:0' }, { hex: '#E4007F', label: 'C:0 M:100 Y:0 K:0' },
        { hex: '#E5004F', label: 'C:0 M:100 Y:50 K:0' }, { hex: '#231815', label: 'C:0 M:0 Y:0 K:100' },
        { hex: '#595757', label: 'C:0 M:0 Y:0 K:80' }, { hex: '#828282', label: 'C:0 M:0 Y:0 K:60' },
        { hex: '#B2B2B2', label: 'C:0 M:0 Y:0 K:40' }, { hex: '#D9D9D9', label: 'C:0 M:0 Y:0 K:20' },
        { hex: '#843911', label: 'C:30 M:80 Y:100 K:0' }, { hex: '#004731', label: 'C:100 M:0 Y:70 K:60' }
    ];

    /* 暗色テーマ向けの発光系スウォッチ */
    var NEON_SWATCHES = [
        { hex: '#00E5FF', label: 'CYAN' }, { hex: '#00FF9C', label: 'MINT' },
        { hex: '#7CFF00', label: 'LIME' }, { hex: '#FFE500', label: 'YELLOW' },
        { hex: '#FF9E00', label: 'AMBER' }, { hex: '#FF3B30', label: 'RED' },
        { hex: '#FF2D95', label: 'MAGENTA' }, { hex: '#C77DFF', label: 'VIOLET' },
        { hex: '#5B8CFF', label: 'BLUE' }, { hex: '#FFFFFF', label: 'WHITE' },
        { hex: '#B0BEC5', label: 'STEEL' }, { hex: '#8D6E63', label: 'BRONZE' }
    ];

    /* ------------------------------------------------------------------ *
     * PNG に pHYs（物理解像度）チャンクを差し込む
     * ------------------------------------------------------------------ */
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256), c, n, k;
        for (n = 0; n < 256; n++) {
            c = n;
            for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function u32be(view, offset, value) {
        view[offset] = (value >>> 24) & 0xFF;
        view[offset + 1] = (value >>> 16) & 0xFF;
        view[offset + 2] = (value >>> 8) & 0xFF;
        view[offset + 3] = value & 0xFF;
    }

    /**
     * PNG バイト列に pHYs チャンクを挿入して返す。
     * PNG は「8バイト署名 → IHDR(長さ13固定)」で始まるため、挿入位置は必ず 33 バイト目。
     * @param {Uint8Array} png
     * @param {number} ppmX 1メートルあたりのピクセル数(X)
     * @param {number} ppmY 1メートルあたりのピクセル数(Y)
     */
    function injectPhys(png, ppmX, ppmY) {
        var SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        for (var i = 0; i < 8; i++) {
            if (png[i] !== SIG[i]) return png; // PNG でなければ何もしない
        }
        var INSERT_AT = 33; // 8(署名) + 4(長さ) + 4('IHDR') + 13(データ) + 4(CRC)

        var chunk = new Uint8Array(21); // 4 + 4 + 9 + 4
        u32be(chunk, 0, 9);
        chunk[4] = 0x70; chunk[5] = 0x48; chunk[6] = 0x59; chunk[7] = 0x73; // 'pHYs'
        u32be(chunk, 8, ppmX);
        u32be(chunk, 12, ppmY);
        chunk[16] = 1; // 単位 = メートル
        u32be(chunk, 17, crc32(chunk.subarray(4, 17)));

        var out = new Uint8Array(png.length + chunk.length);
        out.set(png.subarray(0, INSERT_AT), 0);
        out.set(chunk, INSERT_AT);
        out.set(png.subarray(INSERT_AT), INSERT_AT + chunk.length);
        return out;
    }

    /* ------------------------------------------------------------------ *
     * 小物
     * ------------------------------------------------------------------ */
    function $(id) { return id ? document.getElementById(id) : null; }

    function rgbToHex(value) {
        if (!value) return '';
        value = String(value).trim();
        if (value.charAt(0) === '#') {
            if (value.length === 4) {
                return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
            }
            return value.toLowerCase();
        }
        var m = value.match(/-?\d+(\.\d+)?/g);
        if (!m || m.length < 3) return '';
        return '#' + m.slice(0, 3).map(function (n) {
            var h = Math.round(parseFloat(n)).toString(16);
            return h.length === 1 ? '0' + h : h;
        }).join('').toLowerCase();
    }

    function nextFrame() {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        });
    }

    function downloadBlob(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* ------------------------------------------------------------------ *
     * 本体
     * ------------------------------------------------------------------ */
    function CardKit(cfg) {
        if (!(this instanceof CardKit)) return new CardKit(cfg);
        this.cfg = cfg;
        this.widthMm = cfg.widthMm || 91;
        this.heightMm = cfg.heightMm || 55;
        this.dpi = cfg.dpi || 600;
        this.card = $(cfg.card || 'productCard');
        this.area = $(cfg.captureArea || 'captureArea') || document.querySelector('.preview-area') || document.querySelector('#captureArea');
        this.statusEl = $(cfg.status || 'exportStatus');
        this.accentColor = (cfg.accent && cfg.accent.default) || '#E60012';
        this.presetId = cfg.presets ? cfg.presets.list[0].id : null;
        this.imageData = '';
        this._init();
    }

    CardKit.prototype.status = function (msg, duration) {
        if (!this.statusEl) return;
        var el = this.statusEl;
        el.innerText = msg;
        el.style.display = 'block';
        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(function () { el.style.display = 'none'; }, duration || 3000);
    };

    /* ---- 入力 → プレビュー 同期 ---- */
    CardKit.prototype.sync = function () {
        var cfg = this.cfg;
        (cfg.fields || []).forEach(function (f) {
            var input = $(f.input), target = $(f.target);
            if (!input || !target) return;
            target.innerText = input.value;
        });
        (cfg.ranges || []).forEach(function (r) {
            var input = $(r.input);
            if (!input) return;
            var v = input.value;
            var display = $(r.display);
            if (display) display.innerText = v + (r.unit || '');
            var target = $(r.target);
            if (target && r.style) {
                target.style[r.style] = v + (r.unit || '');
                // スライダで文字サイズを決める欄が .ck-fit でもある場合、
                // 指定された値を autofit の基準サイズにする（そうしないと
                // autofit が初回のサイズに戻してしまい、スライダが効かなくなる）
                if (r.style === 'fontSize' && target.classList.contains('ck-fit')) {
                    target.dataset.ckBase = parseFloat(getComputedStyle(target).fontSize);
                }
            }
        });
        if (cfg.onSync) cfg.onSync(this);
        this.autofit();
    };

    /*
     * .ck-fit を付けた要素は、入力が長すぎて枠からはみ出すときだけ文字を縮める。
     * 名刺サイズのカードは横幅が固定なので、これが無いと
     * 「Gateron Pro Yellow 2.0 (lubed, 67g)」のような実在する長さでレイアウトが崩れる。
     *
     *   .ck-fit           … 1行のまま横幅に合わせて縮める
     *   .ck-fit-wrap      … 指定行数まで折り返し、その高さに収まるまで縮める
     *                       （--fit-lines で行数、既定 2）
     *   .ck-fit-box       … 要素に割り当てられた高さに収まるまで縮める
     *                       （行数が入力次第で変わるブロック用）
     *
     * 折り返せる方が有利なのは、2行使えば同じ読みやすさで約2倍の文字数が入るため。
     * 1行のまま縮め続けると 3pt 台になり、印刷すると読めなくなる。
     *
     * data-fit-min で下限（元サイズに対する比率／既定 0.62）を指定できる。
     */
    CardKit.prototype.autofit = function () {
        document.querySelectorAll('.ck-fit').forEach(function (el) {
            var base = parseFloat(el.dataset.ckBase);
            if (!base) {
                base = parseFloat(getComputedStyle(el).fontSize);
                if (!base) return;
                el.dataset.ckBase = base;
            }
            var min = base * (parseFloat(el.dataset.fitMin) || 0.62);
            var canWrap = el.classList.contains('ck-fit-wrap');
            var wrap = canWrap || el.classList.contains('ck-fit-box');
            var size, i;

            // 折り返せる要素でも、まずは1行のまま入らないか試す。
            // いきなり折り返すと「2行に収まった時点で縮小をやめる」ため、
            // 見出しが縮まずに改行されてしまう（例: 駅名が2行になる）。
            // data-fit-solo は「1行を保つために何割まで縮めてよいか」（既定 0.8）。
            if (canWrap) {
                // data-fit-solo は「1行を保つためにどこまで縮めてよいか」を単独で決める。
                // 折り返し時の下限(data-fit-min)とは別物なので、そちらで頭打ちにしない。
                var soloMin = base * (parseFloat(el.dataset.fitSolo) || 0.8);
                el.style.whiteSpace = 'nowrap';
                size = base;
                el.style.fontSize = size + 'px';
                var soloFits = false;
                for (i = 0; i < 30; i++) {
                    if (el.scrollWidth <= el.clientWidth + 0.5) { soloFits = true; break; }
                    if (size <= soloMin) break;
                    size = Math.max(soloMin, size * 0.94);
                    el.style.fontSize = size + 'px';
                }
                if (soloFits) return;   // 1行で収まったのでここまで
                el.style.whiteSpace = ''; // 収まらないので折り返しに戻す
            }

            size = base;
            el.style.fontSize = size + 'px';
            // 1px ずつではなく比率で詰めるので、長い文字列でも数回で収束する
            for (i = 0; i < 30 && size > min; i++) {
                var fits = wrap
                    ? el.scrollHeight <= el.clientHeight + 0.5
                    : el.scrollWidth <= el.clientWidth + 0.5;
                if (fits) break;
                size = Math.max(min, size * 0.94);
                el.style.fontSize = size + 'px';
            }
        });
    };

    /* ---- 配色 ---- */
    CardKit.prototype.setAccent = function (hex, label) {
        var cfg = this.cfg;
        if (!cfg.accent) return;
        this.accentColor = hex;
        var vars = cfg.accent.vars ? cfg.accent.vars(hex) : null;
        if (vars) {
            Object.keys(vars).forEach(function (k) {
                document.documentElement.style.setProperty(k, vars[k]);
            });
        } else {
            document.documentElement.style.setProperty(cfg.accent.cssVar || '--accent-color', hex);
        }
        var labelEl = $(cfg.accent.labelDisplay);
        if (labelEl) labelEl.innerText = label || 'CUSTOM';
        var lower = String(hex).toLowerCase();
        document.querySelectorAll('#' + (cfg.accent.grid || 'swatchGrid') + ' .color-dot').forEach(function (dot) {
            dot.classList.toggle('active', (dot.dataset.hex || '').toLowerCase() === lower);
        });
    };

    CardKit.prototype.setPreset = function (id) {
        var cfg = this.cfg;
        if (!cfg.presets) return;
        var preset = cfg.presets.list.filter(function (p) { return p.id === id; })[0];
        if (!preset) return;
        this.presetId = id;
        Object.keys(preset.vars).forEach(function (k) {
            document.documentElement.style.setProperty(k, preset.vars[k]);
        });
        var labelEl = $(cfg.presets.labelDisplay);
        if (labelEl) labelEl.innerText = preset.label;
        document.querySelectorAll('#' + (cfg.presets.grid || 'swatchGrid') + ' .color-dot').forEach(function (dot) {
            dot.classList.toggle('active', dot.dataset.preset === id);
        });
    };

    CardKit.prototype._buildSwatches = function () {
        var cfg = this.cfg, self = this;
        if (cfg.presets) {
            var pgrid = $(cfg.presets.grid || 'swatchGrid');
            if (!pgrid) return;
            pgrid.innerHTML = '';
            cfg.presets.list.forEach(function (p) {
                var dot = document.createElement('div');
                dot.className = 'color-dot';
                dot.style.background = p.swatch || p.vars['--accent-color'] || '#888';
                dot.dataset.preset = p.id;
                dot.title = p.label;
                dot.onclick = function () { self.setPreset(p.id); };
                pgrid.appendChild(dot);
            });
            self.setPreset(self.presetId);
            return;
        }
        if (!cfg.accent) return;
        var grid = $(cfg.accent.grid || 'swatchGrid');
        if (!grid) return;
        var list = cfg.accent.swatches || CMYK_SWATCHES;
        grid.innerHTML = '';
        list.forEach(function (s) {
            var dot = document.createElement('div');
            dot.className = 'color-dot';
            dot.style.backgroundColor = s.hex;
            dot.dataset.hex = s.hex;
            dot.title = s.label;
            dot.onclick = function () { self.setAccent(s.hex, s.label); };
            grid.appendChild(dot);
        });
        self.setAccent(self.accentColor, cfg.accent.defaultLabel || (list[0] && list[0].label));
    };

    /* ---- 画像（sketch / dq_pixel など） ---- */
    CardKit.prototype.applyImageTransform = function () {
        var img = this.cfg.image;
        if (!img) return;
        var el = $(img.target);
        if (!el) return;
        var x = img.posX ? ($(img.posX) || {}).value || 0 : 0;
        var y = img.posY ? ($(img.posY) || {}).value || 0 : 0;
        var s = img.scale ? ($(img.scale) || {}).value || 1 : 1;
        el.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')';
        if (img.multiply) {
            var chk = $(img.multiply);
        this.fit();
    };

    CardKit.prototype.buildSizeSelector = function () {
        var sel = $('cardSizeSelect');
        var self = this;
        if (!sel) return;
        sel.onchange = function () {
            var parts = sel.value.split('x');
            self.setSize(parts[0], parts[1]);
        };
    };

    CardKit.prototype.setImage = function (dataUrl) {
        var img = this.cfg.image;
        if (!img) return;
        this.imageData = dataUrl || '';
        var el = $(img.target), ph = $(img.placeholder);
        if (el) {
            el.src = this.imageData;
            el.style.display = this.imageData ? '' : 'none';
        }
        if (ph) ph.style.display = this.imageData ? 'none' : '';
        this.applyImageTransform();
    };

    /* ---- ファイル名 ---- */
    CardKit.prototype.baseName = function () {
        var cfg = this.cfg;
        var el = $(cfg.nameSource || 'codeNameInput');
        var base = (el && el.value ? el.value : '').trim().replace(/[\\/:*?"<>|\s]+/g, '-');
        return base || 'Card';
    };

    CardKit.prototype.timestamp = function () {
        var d = new Date();
        var p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
            'T' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
    };

    /* ---- JSON 保存 / 読込 ---- */
    CardKit.prototype.collect = function () {
        var cfg = this.cfg, self = this;
        var data = { 
            theme: cfg.theme, 
            version: 2,
            widthMm: this.widthMm,
            heightMm: this.heightMm
        };
        (cfg.fields || []).forEach(function (f) {
            var input = $(f.input);
            if (input) data[f.key || f.input] = input.value;
        });
        (cfg.ranges || []).forEach(function (r) {
            var input = $(r.input);
            if (input) data[r.key || r.input] = input.value;
        });
        (cfg.selects || []).forEach(function (s) {
            var input = $(s.input);
            if (input) data[s.key || s.input] = input.value;
        });
        (cfg.toggles || []).forEach(function (t) {
            var input = $(t.input);
            if (input) data[t.key || t.input] = input.checked;
        });
        if (cfg.accent) {
            data[cfg.accent.key || 'accentColor'] = this.accentColor;
            var labelEl = $(cfg.accent.labelDisplay);
            if (labelEl) data.colorLabel = labelEl.innerText;
        }
        if (cfg.presets) data[cfg.presets.key || 'preset'] = this.presetId;
        if (cfg.image) {
            var img = cfg.image;
            data[img.key || 'image'] = this.imageData; // 画像本体も base64 で保存する
            if (img.posX) data.imgX = ($(img.posX) || {}).value;
            if (img.posY) data.imgY = ($(img.posY) || {}).value;
            if (img.scale) data.imgS = ($(img.scale) || {}).value;
            if (img.multiply) data.imgM = ($(img.multiply) || {}).checked;
        }
        if (cfg.onCollect) cfg.onCollect(data, this);
        data.exportedAt = new Date().toISOString();
        return data;
    };

    CardKit.prototype.apply = function (data) {
        var cfg = this.cfg, self = this;
        var pick = function (obj, keys) {
            for (var i = 0; i < keys.length; i++) {
                if (keys[i] && obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
            }
            return undefined;
        };
        (cfg.fields || []).forEach(function (f) {
            var input = $(f.input);
            var v = pick(data, [f.key, f.input].concat(f.legacy || []));
            if (input && v !== undefined) input.value = v;
        });
        (cfg.ranges || []).forEach(function (r) {
            var input = $(r.input);
            var v = pick(data, [r.key, r.input].concat(r.legacy || []));
            if (input && v !== undefined) input.value = v;
        });
        (cfg.selects || []).forEach(function (s) {
            var input = $(s.input);
            var v = pick(data, [s.key, s.input].concat(s.legacy || []));
            if (input && v !== undefined) {
                input.value = v;
                if (s.cssVar) document.documentElement.style.setProperty(s.cssVar, v);
            }
        });
        (cfg.toggles || []).forEach(function (t) {
            var input = $(t.input);
            var v = pick(data, [t.key, t.input].concat(t.legacy || []));
            if (input && v !== undefined) input.checked = !!v;
        });
        if (cfg.accent) {
            var hex = pick(data, [cfg.accent.key, 'accentColor']);
            if (hex) self.setAccent(hex, data.colorLabel || data.cmykLabel || 'CUSTOM');
        }
        if (cfg.presets) {
            var pid = pick(data, [cfg.presets.key, 'preset', 'theme']);
            if (pid) self.setPreset(pid);
        }
        if (cfg.image) {
            var src = pick(data, [cfg.image.key, 'image']);
            ['posX', 'posY', 'scale'].forEach(function (k, i) {
                var id = cfg.image[k];
                var v = data[['imgX', 'imgY', 'imgS'][i]];
                if (id && $(id) && v !== undefined) $(id).value = v;
            });
            if (cfg.image.multiply && $(cfg.image.multiply) && data.imgM !== undefined) {
                $(cfg.image.multiply).checked = !!data.imgM;
            }
            if (src !== undefined) self.setImage(src);
            else self.applyImageTransform();
        }
        if (cfg.onApply) cfg.onApply(data, self);
        self.sync();
        self.fit();
    };

    CardKit.prototype.setZoom = function (zoomMult) {
        this.zoomFactor = parseFloat(zoomMult) || 1.0;
        var self = this;
        document.querySelectorAll('.ck-zoom-btn').forEach(function (btn) {
            btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.zoom) - self.zoomFactor) < 0.05);
        });
        this.fit();
    };

    CardKit.prototype._buildZoomControl = function () {
        var area = this.area;
        if (!area || area.querySelector('.ck-zoom-bar')) return;
        var bar = document.createElement('div');
        bar.className = 'ck-zoom-bar';
        bar.innerHTML = 
            '<span>🔍 プレビュー倍率 / Zoom</span>' +
            '<div style="display:flex;gap:4px">' +
            '<button data-zoom="1.0" class="ck-zoom-btn active">標準</button>' +
            '<button data-zoom="1.25" class="ck-zoom-btn">1.25× 大</button>' +
            '<button data-zoom="1.5" class="ck-zoom-btn">1.5× 特大</button>' +
            '<button data-zoom="2.0" class="ck-zoom-btn">2.0× 超大</button>' +
            '</div>';
        area.insertBefore(bar, area.firstChild);

        var self = this;
        bar.querySelectorAll('.ck-zoom-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                self.setZoom(btn.dataset.zoom);
            });
        });
    };

    /* ---- レスポンシブ表示スケール ---- */
    CardKit.prototype.fit = function () {
        var card = this.card, area = this.area;
        if (!card || !area) return;

        var avail = area.clientWidth;
        if (avail < 50) {
            var self = this;
            if (!this._retryFitTimer) {
                this._retryFitTimer = setTimeout(function () {
                    self._retryFitTimer = null;
                    self.fit();
                }, 50);
            }
            return;
        }

        card.style.transform = 'none';
        var rect = card.getBoundingClientRect();
        var natW = rect.width, natH = rect.height;
        if (!natW) return;

        var pad = this.cfg.fitPadding === undefined ? 24 : this.cfg.fitPadding;
        var usable = Math.max(avail - pad, 100);
        var autoScale = Math.min(usable / natW, this.cfg.maxScale || 4.0);
        autoScale = Math.max(autoScale, 0.2);

        var userZoom = parseFloat(this.zoomFactor) || 1.0;
        var scale = autoScale * userZoom;

        card.style.transformOrigin = 'top center';
        card.style.transform = 'scale(' + scale + ')';
        var headerPad = area.querySelector('.ck-zoom-bar') ? 48 : 16;
        area.style.height = Math.ceil(natH * scale + pad + headerPad) + 'px';
        this._scale = scale;
    };

    /* ---- PNG 描画（バイト列を返すところまで） ---- */
    CardKit.prototype.renderPng = async function () {
        var cfg = this.cfg, card = this.card;
        if (typeof html2canvas === 'undefined') throw new Error('html2canvas not loaded');

        var prevTransform = card.style.transform;
        var prevOrigin = card.style.transformOrigin;
        var outW = Math.round(this.widthMm / MM_PER_INCH * this.dpi);
        var outH = Math.round(this.heightMm / MM_PER_INCH * this.dpi);

        try {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
            this.autofit(); // 実フォントが載った状態でもう一度詰め直す

            // 表示用スケールと、プレビュー専用の飾り（影・外周ライン）だけを一時的に外す。
            // レイアウトには一切触れないので、出力はプレビューと同じ絵になる。
            card.classList.add('ck-exporting');
            card.style.transform = 'none';
            card.style.transformOrigin = 'top left';
            await nextFrame();

            var rect = card.getBoundingClientRect();
            var raw = await html2canvas(card, {
                scale: outW / rect.width,
                backgroundColor: cfg.exportBg || null,
                useCORS: true,
                allowTaint: false,
                logging: false,
                imageTimeout: 0
            });

            // html2canvas の丸めで ±1px ずれることがあるので、実寸から決めた画素数に正規化する
            var out = raw;
            if (raw.width !== outW || raw.height !== outH) {
                out = document.createElement('canvas');
                out.width = outW;
                out.height = outH;
                var g = out.getContext('2d');
                g.imageSmoothingEnabled = true;
                g.imageSmoothingQuality = 'high';
                g.drawImage(raw, 0, 0, outW, outH);
            }

            var blob = await new Promise(function (res) { out.toBlob(res, 'image/png'); });
            var bytes = new Uint8Array(await blob.arrayBuffer());
            // 「この画素数で 91×55mm」になる物理解像度を書き込む
            return {
                bytes: injectPhys(bytes,
                    Math.round(outW / (this.widthMm / 1000)),
                    Math.round(outH / (this.heightMm / 1000))),
                width: outW,
                height: outH,
                dpi: this.dpi
            };
        } finally {
            card.classList.remove('ck-exporting');
            card.style.transform = prevTransform;
            card.style.transformOrigin = prevOrigin;
        }
    };

    /* ---- PNG 書き出し ---- */
    CardKit.prototype.exportPng = async function () {
        var cfg = this.cfg;
        if (typeof html2canvas === 'undefined') { this.status('ライブラリ準備中…'); return; }
        var btn = $(cfg.exportBtn || 'btnExport');
        var original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loader"></span> 生成中…'; }
        try {
            var png = await this.renderPng();
            downloadBlob(new Blob([png.bytes], { type: 'image/png' }),
                cfg.theme + '_' + this.baseName() + '_' +
                this.widthMm + 'x' + this.heightMm + 'mm-' + this.dpi + 'dpi_' +
                this.timestamp() + '.png');
            this.status('保存完了 — ' + png.width + '×' + png.height + 'px / ' + this.dpi + 'dpi ('
                + this.widthMm + '×' + this.heightMm + 'mm 実寸)', 5000);
        } catch (err) {
            console.error('[CardKit] export failed:', err);
            this.status('書き出しに失敗しました');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    };

    CardKit.prototype._buildSizeSelector = function () {
        var self = this;
        var select = $('cardSizeSelect');
        if (!select) {
            var panel = document.querySelector('.editor-panel');
            if (!panel) return;
            var field = document.createElement('div');
            field.className = 'ck-field';
            field.style.marginBottom = '1.25rem';
            field.style.borderBottom = '1px solid var(--ui-border, rgba(255,255,255,0.15))';
            field.style.paddingBottom = '0.85rem';
            field.innerHTML = 
                '<label class="ck-label" for="cardSizeSelect" style="display:flex;align-items:center;justify-content:space-between;font-weight:700">' +
                '<span>📐 印刷サイズ / Card Size</span>' +
                '<span style="font-size:9.5px;opacity:0.85" id="cardSizeDimDisplay">91 × 55 mm</span>' +
                '</label>' +
                '<select id="cardSizeSelect" class="ck-input" style="width:100%;margin-top:4px;padding:6px;font-weight:700;cursor:pointer">' +
                '<option value="91x55" selected>名刺サイズ (91 × 55 mm)</option>' +
                '<option value="127x89">写真 L判 (127 × 89 mm)</option>' +
                '<option value="152x102">KGサイズ / はがき (152 × 102 mm) — L判より大きめ</option>' +
                '<option value="178x127">写真 2L判 (178 × 127 mm)</option>' +
                '<option value="210x148">A5サイズ (210 × 148 mm) — A4の半分</option>' +
                '<option value="297x210">A4サイズ (297 × 210 mm) — 全面</option>' +
                '</select>';
            var firstLabel = panel.querySelector('.ck-label');
            if (firstLabel && firstLabel.parentNode === panel) {
                panel.insertBefore(field, firstLabel.nextSibling);
            } else {
                panel.insertBefore(field, panel.firstChild);
            }
            select = $('cardSizeSelect');
        }

        if (select) {
            select.addEventListener('change', function (e) {
                var parts = e.target.value.split('x');
                if (parts.length === 2) {
                    self.setSize(parts[0], parts[1]);
                }
            });
        }
    };

    /* ---- 初期化 ---- */
    CardKit.prototype._init = function () {
        var self = this, cfg = this.cfg;

        this._buildZoomControl();
        this._buildSizeSelector();

        var syncHandler = function () { self.sync(); };
        (cfg.fields || []).forEach(function (f) {
            var el = $(f.input);
            if (el) el.addEventListener('input', syncHandler);
        });
        (cfg.ranges || []).forEach(function (r) {
            var el = $(r.input);
            if (el) el.addEventListener('input', syncHandler);
        });
        (cfg.selects || []).forEach(function (s) {
            var el = $(s.input);
            if (!el) return;
            el.addEventListener('change', function (e) {
                if (s.cssVar) document.documentElement.style.setProperty(s.cssVar, e.target.value);
                if (s.onChange) s.onChange(e.target.value, self);
                self.sync();
            });
            if (s.cssVar && el.value) document.documentElement.style.setProperty(s.cssVar, el.value);
        });
        (cfg.toggles || []).forEach(function (t) {
            var el = $(t.input);
            if (el) el.addEventListener('change', function () {
                if (t.onChange) t.onChange(el.checked, self);
                self.sync();
            });
        });

        this._buildSwatches();

        if (cfg.image) {
            var img = cfg.image;
            var fileEl = $(img.input);
            if (fileEl) {
                fileEl.addEventListener('change', function (e) {
                    var file = e.target.files && e.target.files[0];
                    if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function (ev) { self.setImage(ev.target.result); };
                    reader.readAsDataURL(file);
                });
            }
            [img.posX, img.posY, img.scale].forEach(function (id) {
                var el = $(id);
                if (el) el.addEventListener('input', function () { self.applyImageTransform(); });
            });
            var mul = $(img.multiply);
            if (mul) mul.addEventListener('change', function () { self.applyImageTransform(); });
            var clear = $(img.clear);
            if (clear) clear.addEventListener('click', function () {
                self.setImage('');
                if (fileEl) fileEl.value = '';
            });
        }

        var exportBtn = $(cfg.exportBtn || 'btnExport');
        if (exportBtn) exportBtn.addEventListener('click', function () { self.exportPng(); });

        var jsonOut = $(cfg.exportJsonBtn || 'exportJsonBtn');
        if (jsonOut) jsonOut.addEventListener('click', function () {
            var data = self.collect();
            downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
                cfg.theme + '_' + self.baseName() + '_' + self.timestamp() + '.json');
            self.status('設定ファイルを保存しました');
        });

        var fileInput = $(cfg.jsonFileInput || 'jsonFileInput');
        var jsonIn = $(cfg.importJsonBtn || 'importJsonBtn');
        if (jsonIn && fileInput) {
            jsonIn.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function (ev) {
                    try {
                        self.apply(JSON.parse(ev.target.result));
                        self.status('設定を読み込みました');
                    } catch (err) {
                        console.error('[CardKit] import failed:', err);
                        self.status('読み込みに失敗しました');
                    }
                };
                reader.readAsText(file);
                e.target.value = '';
            });
        }

        var refit = function () {
            cancelAnimationFrame(self._fitRaf);
            self._fitRaf = requestAnimationFrame(function () { self.autofit(); self.fit(); });
        };
        if (typeof ResizeObserver !== 'undefined' && this.area) {
            try {
                var ro = new ResizeObserver(function () { refit(); });
                ro.observe(this.area);
            } catch (err) {}
        }

        if (cfg.image) this.applyImageTransform();
        this.sync();
        this.fit();
        global.cardKit = this; // デバッグ・自動検証用
        if (cfg.onReady) cfg.onReady(this);
    };

    CardKit.CMYK = CMYK_SWATCHES;
    CardKit.NEON = NEON_SWATCHES;
    CardKit.rgbToHex = rgbToHex;
    CardKit.injectPhys = injectPhys;
    CardKit.MM_PER_INCH = MM_PER_INCH;
    CardKit.CSS_DPI = CSS_DPI;

    global.CardKit = CardKit;
})(window);
