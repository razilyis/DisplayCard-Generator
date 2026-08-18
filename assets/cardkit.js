/*!
 * CardKit — DisplayCard-Generator shared engine
 *
 * 各テーマ HTML が共通で使う「入力とプレビューの同期 / 配色スウォッチ / JSON 保存・読込 /
 * 印刷向け PNG 書き出し」をまとめたもの。
 *
 * 印刷ズレ対策の要点:
 *   1. 書き出しはプレビュー中のカード要素そのものを撮る。表示用の transform: scale() は
 *      撮影の直前だけ外し、レイアウトを一切いじらない（= プレビューと出力が完全一致）。
 *   2. デザイン基準幅は固定し、印刷サイズ変更で文字や余白を相対的に小さくしない。
 *      出力ピクセル数だけを「実寸 mm × DPI」から決め打ちする。
 *   3. PNG に pHYs チャンク（物理解像度）を書き込む。これにより Illustrator / Word /
 *      プレビュー.app などが選択した実寸で配置する。
 */
(function (global) {
    'use strict';

    var MM_PER_INCH = 25.4;
    var CSS_DPI = 96; // CSS の 1in = 96px 固定
    var DESIGN_WIDTH_MM = 127; // レイアウト基準幅。印刷サイズを変えても文字比率を維持する
    var DEFAULT_FREE_COMMENT = [
        'zmk firmware を採用した、トラックボール搭載の40％くらいの左右分割キーボードです。',
        'ケースの組み立てにはねじを使わずスナップフィット構造になっています。',
        'トラックボールケースの取り外しが可能になっています。'
    ].join('\n');

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
        this.widthMm = cfg.widthMm || 127;
        this.heightMm = cfg.heightMm || 89;
        this.dpi = cfg.dpi || 600;
        this.card = $(cfg.card || 'productCard');
        this.area = $(cfg.captureArea || 'captureArea') || document.querySelector('.preview-area') || document.querySelector('#captureArea');
        this.statusEl = $(cfg.status || 'exportStatus');
        this.accentColor = (cfg.accent && cfg.accent.default) || '#E60012';
        this.presetId = cfg.presets ? cfg.presets.list[0].id : null;
        this.imageData = '';
        this.imageMonochrome = null;
        this._imageColorToken = 0;
        this._imageRenderPromise = null;
        this.zoomFactor = 1.0;
        this.designMode = true;
        this._designItems = {};
        this._selectedDesignKey = '';
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
        this._syncFreeCommentFont();
        this._placeFreeComment();
        this.autofit();
        this._placeFreeComment();
        this.fit();
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
            if (el.classList.contains('ck-design-box-only')) return;
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
                el.style.whiteSpace = 'normal'; // テーマ側のnowrap指定より優先して折り返す
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
    CardKit.prototype.applyImageTransform = function (preserveDimensions) {
        var img = this.cfg.image;
        if (!img) return;
        var el = $(img.target);
        if (!el) return;
        var x = img.posX ? ($(img.posX) || {}).value || 0 : 0;
        var y = img.posY ? ($(img.posY) || {}).value || 0 : 0;
        var s = img.scale ? ($(img.scale) || {}).value || 1 : 1;
        var designItem = this._designItems && this._designItems.image;
        if (designItem) {
            designItem.x = parseFloat(x) || 0;
            designItem.y = parseFloat(y) || 0;
            if (!preserveDimensions) {
                designItem.scale = parseFloat(s) || 1;
                designItem.scaleX = designItem.scale;
                designItem.scaleY = designItem.scale;
            }
            designItem.scaleText = true;
            this._renderDesignItem(designItem);
            if (this._selectedDesignKey === 'image') this._selectDesignItem(designItem);
        } else {
            el.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')';
        }
        if (img.multiply) {
            var chk = $(img.multiply);
            el.style.mixBlendMode = (chk && chk.checked) ? 'multiply' : 'normal';
        }
        this.fit();
    };

    CardKit.prototype._refreshImageColor = function () {
        var self = this;
        var image = this.cfg.image;
        var target = image && $(image.target);
        if (!target) return Promise.resolve();
        target.style.filter = 'none';
        var token = ++this._imageColorToken;
        var waitForTarget = function () {
            if (typeof target.decode !== 'function') return Promise.resolve();
            return target.decode().catch(function () {});
        };

        if (!this.imageData) {
            target.src = '';
            this._imageRenderPromise = Promise.resolve();
            return this._imageRenderPromise;
        }
        if (!this.imageMonochrome) {
            target.src = this.imageData;
            this._imageRenderPromise = waitForTarget();
            return this._imageRenderPromise;
        }

        this._imageRenderPromise = new Promise(function (resolve) {
            var source = new Image();
            source.onload = function () {
                if (token !== self._imageColorToken) { resolve(); return; }
                try {
                    var canvas = document.createElement('canvas');
                    canvas.width = source.naturalWidth || source.width;
                    canvas.height = source.naturalHeight || source.height;
                    var context = canvas.getContext('2d');
                    context.drawImage(source, 0, 0);
                    var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                    var data = pixels.data;
                    for (var i = 0; i < data.length; i += 4) {
                        var gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
                        data[i] = gray;
                        data[i + 1] = gray;
                        data[i + 2] = gray;
                    }
                    context.putImageData(pixels, 0, 0);
                    if (token === self._imageColorToken) target.src = canvas.toDataURL('image/png');
                } catch (error) {
                    console.error('[CardKit] monochrome conversion failed:', error);
                    if (token === self._imageColorToken) target.src = self.imageData;
                }
                waitForTarget().then(resolve);
            };
            source.onerror = function () {
                if (token === self._imageColorToken) target.src = self.imageData;
                waitForTarget().then(resolve);
            };
            source.src = self.imageData;
        });
        return this._imageRenderPromise;
    };

    CardKit.prototype._setImageMonochrome = function (enabled) {
        this.imageMonochrome = !!enabled;
        var checkbox = $('ckImageMonochrome');
        if (checkbox) checkbox.checked = this.imageMonochrome;
        this._refreshImageColor();
    };

    CardKit.prototype.setImage = function (dataUrl) {
        var img = this.cfg.image;
        if (!img) return;
        this.imageData = dataUrl || '';
        var el = $(img.target), ph = $(img.placeholder);
        if (el) {
            el.style.display = this.imageData ? '' : 'none';
        }
        if (ph) ph.style.display = this.imageData ? 'none' : '';
        this._refreshImageColor();
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
            version: 3,
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
            data.imageMonochrome = !!this.imageMonochrome;
            if (img.posX) data.imgX = ($(img.posX) || {}).value;
            if (img.posY) data.imgY = ($(img.posY) || {}).value;
            if (img.scale) data.imgS = ($(img.scale) || {}).value;
            if (img.multiply) data.imgM = ($(img.multiply) || {}).checked;
        }
        if (cfg.onCollect) cfg.onCollect(data, this);
        data.freeComment = ($('freeCommentInput') || {}).value || '';
        data.freeCommentPosition = ($('freeCommentPosition') || {}).value || 'auto';
        data.freeCommentSize = ($('freeCommentSize') || {}).value || '8';
        data.designLayout = this._collectDesignLayout();
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
            if (data.imageMonochrome !== undefined) self.imageMonochrome = !!data.imageMonochrome;
            var monochromeToggle = $('ckImageMonochrome');
            if (monochromeToggle) monochromeToggle.checked = !!self.imageMonochrome;
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
        if (data.widthMm && data.heightMm) self.setSize(data.widthMm, data.heightMm);
        if ($('freeCommentInput') && data.freeComment !== undefined) $('freeCommentInput').value = data.freeComment;
        if ($('freeCommentPosition') && data.freeCommentPosition) $('freeCommentPosition').value = data.freeCommentPosition;
        if ($('freeCommentSize') && data.freeCommentSize) $('freeCommentSize').value = data.freeCommentSize;
        self._syncFreeComment();
        self.sync();
        self._applyDesignLayout(data.designLayout || {});
        if (cfg.image && !(data.designLayout && data.designLayout.image)) self.applyImageTransform();
        self.fit();
    };

    /* ---- 印刷サイズ ---- */
    CardKit.prototype.setSize = function (widthMm, heightMm) {
        widthMm = parseFloat(widthMm);
        heightMm = parseFloat(heightMm);
        if (!(widthMm > 0 && heightMm > 0)) return;

        this.widthMm = widthMm;
        this.heightMm = heightMm;
        // 印刷サイズをそのままCSS寸法へ入れると、A5などでカードだけが広がり、
        // 固定ptの文字が相対的に小さくなる。レイアウト幅はL判相当へ固定し、
        // 選択サイズの縦横比だけを反映する。実際の大きさはPNG画素数とpHYsで決める。
        var designHeightMm = DESIGN_WIDTH_MM * heightMm / widthMm;
        document.documentElement.style.setProperty('--card-width', DESIGN_WIDTH_MM + 'mm');
        document.documentElement.style.setProperty('--card-height', designHeightMm + 'mm');

        var select = $('cardSizeSelect');
        if (select) select.value = widthMm + 'x' + heightMm;
        var dim = $('cardSizeDimDisplay');
        if (dim) dim.innerText = widthMm + ' × ' + heightMm + ' mm';
        var dpi = this.dpi;
        document.querySelectorAll('.ck-print-note').forEach(function (note) {
            note.innerHTML = widthMm + '×' + heightMm + 'mm / ' + dpi + 'dpi・実寸情報つきPNG<br>印刷ソフトにそのまま置けば実寸で出ます';
        });

        this.autofit();
        this.fit();
    };

    /* ---- 長い製品名をテーマ共通で読みやすく収める ---- */
    CardKit.prototype._prepareLongTextFields = function () {
        (this.cfg.fields || []).forEach(function (field) {
            var semantic = [field.key, field.input, field.target].join(' ');
            if (/label/i.test(semantic)) return;
            if (!/(codeName|keyboard|keySwitch|switch|keyCaps|keycap|displayVal[123])/i.test(semantic)) return;
            var target = $(field.target);
            if (!target) return;
            target.classList.add('ck-fit', 'ck-fit-wrap', 'ck-product-name');
            if (target.parentElement && target.parentElement !== document.body) {
                target.parentElement.classList.add('ck-product-cell');
            }
            if (!target.style.getPropertyValue('--fit-lines')) target.style.setProperty('--fit-lines', '3');
            if (!target.dataset.fitMin) target.dataset.fitMin = '0.62';
            if (!target.dataset.fitSolo) target.dataset.fitSolo = '0.86';
        });
    };

    /* ---- プレビュー上での直接編集 / ドラッグ / 拡大縮小 ---- */
    CardKit.prototype._renderDesignItem = function (item) {
        if (!item || !item.el) return;
        var scaleX = item.scaleX === undefined ? item.scale : item.scaleX;
        var scaleY = item.scaleY === undefined ? item.scale : item.scaleY;
        var changed = item.x || item.y || Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
        var el = item.el;

        if (!changed) {
            el.classList.remove('ck-design-box-only');
            el.style.transform = item.original.transform;
            el.style.transformOrigin = item.original.transformOrigin;
            if (item.key !== 'image') el.style.display = item.original.display;
            el.style.width = item.original.width;
            el.style.height = item.original.height;
            el.style.boxSizing = item.original.boxSizing;
            this._updateDesignOverlay();
            return;
        }

        var transform = 'translate(' + item.x + 'px, ' + item.y + 'px)';
        if (item.scaleText) transform += ' scale(' + scaleX + ', ' + scaleY + ')';
        if (item.baseTransform) transform += ' ' + item.baseTransform;
        el.style.transform = transform;
        el.style.transformOrigin = 'top left';

        if (!item.scaleText && (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001)) {
            el.classList.add('ck-design-box-only');
            if (item.computedDisplay === 'inline') el.style.display = 'inline-block';
            el.style.boxSizing = 'border-box';
            el.style.width = Math.max(1, item.baseWidth * scaleX) + 'px';
            el.style.height = Math.max(1, item.baseHeight * scaleY) + 'px';
        } else {
            el.classList.remove('ck-design-box-only');
            if (item.key !== 'image') el.style.display = item.original.display;
            el.style.width = item.original.width;
            el.style.height = item.original.height;
            el.style.boxSizing = item.original.boxSizing;
        }
        this._updateDesignOverlay();
    };

    CardKit.prototype._setDesignOffset = function (item, x, y) {
        if (!item) return;
        item.x = Math.round((parseFloat(x) || 0) * 10) / 10;
        item.y = Math.round((parseFloat(y) || 0) * 10) / 10;
        this._renderDesignItem(item);
        if (item.key === 'image') this._syncImageControlsFromDesign(item);
    };

    CardKit.prototype._setDesignScale = function (item, scale, scaleText) {
        if (!item) return;
        if (!(item.baseWidth > 1) || !(item.baseHeight > 1)) {
            item.baseWidth = item.el.offsetWidth || item.el.getBoundingClientRect().width || 1;
            item.baseHeight = item.el.offsetHeight || item.el.getBoundingClientRect().height || 1;
        }
        var minScale = item.key === 'image' ? 0.1 : 0.5;
        var maxScale = item.key === 'image' ? 3 : 2;
        scale = Math.max(minScale, Math.min(maxScale, parseFloat(scale) || 1));
        scale = Math.round(scale * 100) / 100;
        this._setDesignDimensions(item, scale, scale, scaleText);
    };

    CardKit.prototype._setDesignDimensions = function (item, scaleX, scaleY, scaleText) {
        if (!item) return;
        var minScale = item.key === 'image' ? 0.1 : 0.5;
        var maxScale = item.key === 'image' ? 3 : 2;
        item.scaleX = Math.round(Math.max(minScale, Math.min(maxScale, parseFloat(scaleX) || 1)) * 100) / 100;
        item.scaleY = Math.round(Math.max(minScale, Math.min(maxScale, parseFloat(scaleY) || 1)) * 100) / 100;
        item.scale = Math.round(((item.scaleX + item.scaleY) / 2) * 100) / 100;
        if (item.key === 'image') item.scaleText = true;
        else if (scaleText !== undefined) item.scaleText = !!scaleText;
        this._renderDesignItem(item);
        if (item.key === 'image') this._syncImageControlsFromDesign(item);
    };

    CardKit.prototype._syncImageControlsFromDesign = function (item) {
        var image = this.cfg.image;
        if (!image || !item) return;
        if (image.posX && $(image.posX)) $(image.posX).value = item.x;
        if (image.posY && $(image.posY)) $(image.posY).value = item.y;
        if (image.scale && $(image.scale)) $(image.scale).value = item.scale;
    };

    CardKit.prototype._selectDesignItem = function (item) {
        Object.keys(this._designItems).forEach(function (key) {
            this._designItems[key].el.classList.toggle('ck-design-selected', this._designItems[key] === item);
        }, this);
        this._selectedDesignKey = item ? item.key : '';
        var label = $('ckDesignSelection');
        var scale = $('ckDesignScale');
        var scaleValue = $('ckDesignScaleValue');
        var scaleText = $('ckDesignScaleText');
        if (label) label.textContent = item ? item.label : '要素を選択してください';
        if (scale) {
            scale.disabled = !item;
            scale.min = item && item.key === 'image' ? 0.1 : 0.5;
            scale.max = item && item.key === 'image' ? 3 : 2;
            scale.value = item ? item.scale : 1;
        }
        if (scaleValue) {
            if (!item) scaleValue.textContent = '100%';
            else if (Math.abs(item.scaleX - item.scaleY) < 0.001) {
                scaleValue.textContent = Math.round(item.scaleX * 100) + '%';
            } else {
                scaleValue.textContent = '幅' + Math.round(item.scaleX * 100) + '% / 高さ' +
                    Math.round(item.scaleY * 100) + '%';
            }
        }
        if (scaleText) {
            scaleText.disabled = !item || item.key === 'image';
            scaleText.checked = item ? item.scaleText : true;
        }
        this._updateDesignOverlay();
    };

    CardKit.prototype._updateDesignOverlay = function () {
        var overlay = this._designOverlay;
        var item = this._designItems[this._selectedDesignKey];
        if (!overlay || !this.designMode || !item || !item.el || item.el.hidden) {
            if (overlay) overlay.hidden = true;
            return;
        }
        var rect = item.el.getBoundingClientRect();
        var host = overlay.parentElement;
        var hostRect = host && host.getBoundingClientRect();
        if (!hostRect || !rect.width || !rect.height) {
            overlay.hidden = true;
            return;
        }
        overlay.hidden = false;
        overlay.style.left = rect.left - hostRect.left + 'px';
        overlay.style.top = rect.top - hostRect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
    };

    CardKit.prototype._resizeDesignItem = function (corner, event) {
        var self = this;
        var item = this._designItems[this._selectedDesignKey];
        if (!item || !this.designMode) return;
        event.preventDefault();
        event.stopPropagation();

        var handle = event.currentTarget;
        var startClientX = event.clientX;
        var startClientY = event.clientY;
        var startScaleX = item.scaleX;
        var startScaleY = item.scaleY;
        var startX = item.x;
        var startY = item.y;
        var cardScale = this._scale || 1;
        var startRect = item.el.getBoundingClientRect();
        var startWidth = startRect.width / cardScale;
        var startHeight = startRect.height / cardScale;
        var fromLeft = corner.indexOf('l') !== -1;
        var fromTop = corner.indexOf('t') !== -1;
        var resizeWidth = corner.indexOf('l') !== -1 || corner.indexOf('r') !== -1;
        var resizeHeight = corner.indexOf('t') !== -1 || corner.indexOf('b') !== -1;
        handle.setPointerCapture(event.pointerId);

        var move = function (moveEvent) {
            moveEvent.preventDefault();
            var dx = (moveEvent.clientX - startClientX) / cardScale;
            var dy = (moveEvent.clientY - startClientY) / cardScale;
            var widthRatio = Math.max(0.1, (startWidth + (fromLeft ? -dx : dx)) / startWidth);
            var heightRatio = Math.max(0.1, (startHeight + (fromTop ? -dy : dy)) / startHeight);
            var nextScaleX = resizeWidth ? startScaleX * widthRatio : startScaleX;
            var nextScaleY = resizeHeight ? startScaleY * heightRatio : startScaleY;
            if (resizeWidth && resizeHeight) {
                var uniformRatio = (widthRatio + heightRatio) / 2;
                nextScaleX = startScaleX * uniformRatio;
                nextScaleY = startScaleY * uniformRatio;
            }
            self._setDesignDimensions(item, nextScaleX, nextScaleY, item.scaleText);
            var actualRatioX = item.scaleX / startScaleX;
            var actualRatioY = item.scaleY / startScaleY;
            self._setDesignOffset(item,
                startX + (fromLeft ? startWidth * (1 - actualRatioX) : 0),
                startY + (fromTop ? startHeight * (1 - actualRatioY) : 0));
            var scaleControl = $('ckDesignScale');
            var scaleValue = $('ckDesignScaleValue');
            if (scaleControl) scaleControl.value = item.scale;
            if (scaleValue) {
                scaleValue.textContent = Math.abs(item.scaleX - item.scaleY) < 0.001
                    ? Math.round(item.scaleX * 100) + '%'
                    : '幅' + Math.round(item.scaleX * 100) + '% / 高さ' + Math.round(item.scaleY * 100) + '%';
            }
        };
        var stop = function (upEvent) {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
            if (handle.hasPointerCapture(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    };

    CardKit.prototype._buildDesignOverlay = function () {
        if (!this.stage || this._designOverlay) return;
        var self = this;
        var overlay = document.createElement('div');
        overlay.className = 'ck-design-resize-overlay';
        overlay.hidden = true;
        overlay.innerHTML = ['tl', 'tm', 'tr', 'ml', 'mr', 'bl', 'bm', 'br'].map(function (corner) {
            return '<button type="button" class="ck-design-resize-handle ck-' + corner +
                '" data-corner="' + corner + '" aria-label="サイズ変更"></button>';
        }).join('');
        this.stage.appendChild(overlay);
        this._designOverlay = overlay;
        overlay.querySelectorAll('.ck-design-resize-handle').forEach(function (handle) {
            handle.addEventListener('pointerdown', function (event) {
                self._resizeDesignItem(handle.dataset.corner, event);
            });
        });
    };

    CardKit.prototype._registerDesignItem = function (target, field, key) {
        if (!target || !key || this._designItems[key]) return;
        var self = this;
        var computed = getComputedStyle(target);
        var item = {
            el: target,
            field: field,
            key: key,
            label: (field && (field.key || field.input)) || key,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
            scaleText: true,
            baseWidth: target.offsetWidth || target.getBoundingClientRect().width,
            baseHeight: target.offsetHeight || target.getBoundingClientRect().height,
            baseTransform: computed.transform && computed.transform !== 'none' ? computed.transform : '',
            computedDisplay: computed.display,
            original: {
                transform: target.style.transform || '',
                transformOrigin: target.style.transformOrigin || '',
                display: target.style.display || '',
                width: target.style.width || '',
                height: target.style.height || '',
                boxSizing: target.style.boxSizing || ''
            }
        };
        this._designItems[key] = item;
        target.classList.add('ck-design-item');
        target.dataset.ckDesignKey = key;
        if (key === 'image' || target.tagName === 'IMG') {
            target.draggable = false;
            target.addEventListener('dragstart', function (event) { event.preventDefault(); });
        }

        target.addEventListener('pointerdown', function (event) {
            if (!self.designMode || target.isContentEditable || event.button !== 0) return;
            if (item.key === 'image') event.preventDefault();
            event.stopPropagation();
            self._selectDesignItem(item);
            var startX = event.clientX;
            var startY = event.clientY;
            var originX = item.x;
            var originY = item.y;
            var moved = false;
            target.setPointerCapture(event.pointerId);
            target.classList.add('ck-design-dragging');

            var move = function (moveEvent) {
                var dx = moveEvent.clientX - startX;
                var dy = moveEvent.clientY - startY;
                if (!moved && Math.hypot(dx, dy) < 3) return;
                moved = true;
                moveEvent.preventDefault();
                var cardScale = self._scale || 1;
                self._setDesignOffset(item, originX + dx / cardScale, originY + dy / cardScale);
            };
            var stop = function (upEvent) {
                target.classList.remove('ck-design-dragging');
                target.removeEventListener('pointermove', move);
                target.removeEventListener('pointerup', stop);
                target.removeEventListener('pointercancel', stop);
                if (target.hasPointerCapture(upEvent.pointerId)) target.releasePointerCapture(upEvent.pointerId);
            };
            target.addEventListener('pointermove', move);
            target.addEventListener('pointerup', stop);
            target.addEventListener('pointercancel', stop);
        });

        target.addEventListener('dblclick', function (event) {
            if (!self.designMode || !field) return;
            var input = $(field.input);
            if (!input) return;
            event.preventDefault();
            event.stopPropagation();
            self._selectDesignItem(item);
            var original = input.value;
            target.contentEditable = 'true';
            target.spellcheck = false;
            target.classList.add('ck-design-editing');
            target.focus();

            var selection = global.getSelection && global.getSelection();
            if (selection && document.createRange) {
                var range = document.createRange();
                range.selectNodeContents(target);
                selection.removeAllRanges();
                selection.addRange(range);
            }

            var finish = function (commit) {
                if (!target.isContentEditable) return;
                target.contentEditable = 'false';
                target.classList.remove('ck-design-editing');
                input.value = commit ? target.innerText.replace(/\r/g, '') : original;
                self._syncFreeComment();
                self.sync();
                target.removeEventListener('keydown', onKey);
            };
            var onKey = function (keyEvent) {
                if (keyEvent.key === 'Escape') {
                    keyEvent.preventDefault();
                    finish(false);
                } else if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) {
                    keyEvent.preventDefault();
                    finish(true);
                }
            };
            target.addEventListener('blur', function () { finish(true); }, { once: true });
            target.addEventListener('keydown', onKey);
        });
    };

    CardKit.prototype._setDesignMode = function (enabled) {
        this.designMode = !!enabled;
        if (this.card) this.card.classList.toggle('ck-design-mode', this.designMode);
        var button = $('ckDesignModeBtn');
        if (button) {
            button.classList.toggle('active', this.designMode);
            button.textContent = this.designMode ? '✥ 要素編集 ON' : '✥ 要素編集 OFF';
        }
        this._updateDesignOverlay();
    };

    CardKit.prototype._resetDesignLayout = function () {
        Object.keys(this._designItems).forEach(function (key) {
            var item = this._designItems[key];
            item.x = 0;
            item.y = 0;
            item.scale = 1;
            item.scaleX = 1;
            item.scaleY = 1;
            item.scaleText = true;
            this._renderDesignItem(item);
        }, this);
        this._selectDesignItem(this._designItems[this._selectedDesignKey] || null);
    };

    CardKit.prototype._collectDesignLayout = function () {
        var layout = {};
        Object.keys(this._designItems).forEach(function (key) {
            var item = this._designItems[key];
            if (item.x || item.y || Math.abs(item.scaleX - 1) > 0.001 ||
                Math.abs(item.scaleY - 1) > 0.001 || !item.scaleText) {
                layout[key] = {
                    x: item.x,
                    y: item.y,
                    scale: item.scale,
                    scaleX: item.scaleX,
                    scaleY: item.scaleY,
                    scaleText: item.scaleText
                };
            }
        }, this);
        return layout;
    };

    CardKit.prototype._applyDesignLayout = function (layout) {
        this._resetDesignLayout();
        Object.keys(layout || {}).forEach(function (key) {
            var item = this._designItems[key];
            var saved = layout[key];
            if (!item || !saved) return;
            item.x = parseFloat(saved.x) || 0;
            item.y = parseFloat(saved.y) || 0;
            var minScale = item.key === 'image' ? 0.1 : 0.5;
            var maxScale = item.key === 'image' ? 3 : 2;
            var legacyScale = parseFloat(saved.scale) || 1;
            item.scaleX = Math.max(minScale, Math.min(maxScale, parseFloat(saved.scaleX) || legacyScale));
            item.scaleY = Math.max(minScale, Math.min(maxScale, parseFloat(saved.scaleY) || legacyScale));
            item.scale = Math.round(((item.scaleX + item.scaleY) / 2) * 100) / 100;
            item.scaleText = saved.scaleText !== false;
            this._renderDesignItem(item);
        }, this);
        this._selectDesignItem(this._designItems[this._selectedDesignKey] || null);
    };

    CardKit.prototype._buildDesignEditor = function () {
        if (!this.card || !this.area || $('ckDesignToolbar')) return;
        var self = this;
        (this.cfg.fields || []).forEach(function (field) {
            self._registerDesignItem($(field.target), field, field.key || field.target);
        });
        var freeComment = $('displayFreeComment');
        if (freeComment) {
            this._registerDesignItem(freeComment,
                { input: 'freeCommentInput', target: 'displayFreeComment', key: 'freeComment' }, 'freeComment');
        }
        if (this.cfg.image && $(this.cfg.image.target)) {
            var imageTarget = $(this.cfg.image.target);
            if (this.imageMonochrome === null) {
                var imageStyle = getComputedStyle(imageTarget);
                this.imageMonochrome = /grayscale/i.test(imageTarget.className + ' ' + imageStyle.filter);
            }
            imageTarget.style.filter = 'none';
            this._registerDesignItem(imageTarget, null, 'image');
            var imageItem = this._designItems.image;
            imageItem.label = '画像';
            imageItem.baseTransform = '';
            imageItem.original.transform = '';
            imageItem.x = this.cfg.image.posX ? parseFloat(($(this.cfg.image.posX) || {}).value) || 0 : 0;
            imageItem.y = this.cfg.image.posY ? parseFloat(($(this.cfg.image.posY) || {}).value) || 0 : 0;
            imageItem.scale = this.cfg.image.scale ? parseFloat(($(this.cfg.image.scale) || {}).value) || 1 : 1;
            imageItem.scaleX = imageItem.scale;
            imageItem.scaleY = imageItem.scale;
            imageItem.scaleText = true;
            this._renderDesignItem(imageItem);
        }
        this._buildDesignOverlay();

        var toolbar = document.createElement('div');
        toolbar.id = 'ckDesignToolbar';
        toolbar.className = 'ck-design-toolbar';
        toolbar.innerHTML =
            '<div class="ck-design-toolbar-row">' +
            '<button type="button" id="ckDesignModeBtn" class="ck-design-btn">✥ 要素編集 ON</button>' +
            '<button type="button" id="ckDesignResetBtn" class="ck-design-btn">↺ 配置リセット</button>' +
            '<span id="ckDesignSelection">要素を選択してください</span></div>' +
            '<div class="ck-design-toolbar-row ck-design-scale-controls">' +
            '<label for="ckDesignScale">サイズ</label>' +
            '<input type="range" id="ckDesignScale" min="0.5" max="2" step="0.05" value="1" disabled>' +
            '<output id="ckDesignScaleValue">100%</output>' +
            '<label class="ck-design-check"><input type="checkbox" id="ckDesignScaleText" checked disabled>' +
            '<span>文字も一緒に拡大</span></label></div>' +
            '<small>要素をドラッグで移動・四隅/上下/左右のハンドルでサイズ変更・文字をダブルクリックで編集</small>';
        var stage = this.stage || this.card.parentElement;
        var toolbarHost = stage && stage.parentElement ? stage.parentElement : this.area;
        toolbarHost.insertBefore(toolbar, stage || null);

        if (this.cfg.image) {
            var imageMode = document.createElement('label');
            imageMode.className = 'ck-design-check ck-image-color-mode';
            imageMode.innerHTML = '<input type="checkbox" id="ckImageMonochrome">' +
                '<span>画像をモノクロで表示・出力</span>';
            toolbar.querySelector('.ck-design-scale-controls').appendChild(imageMode);
            $('ckImageMonochrome').checked = !!this.imageMonochrome;
            $('ckImageMonochrome').addEventListener('change', function (event) {
                self._setImageMonochrome(event.target.checked);
            });
            this._refreshImageColor();
        }

        $('ckDesignModeBtn').addEventListener('click', function () {
            self._setDesignMode(!self.designMode);
        });
        $('ckDesignResetBtn').addEventListener('click', function () {
            self._resetDesignLayout();
            if (self._designItems.image) self._syncImageControlsFromDesign(self._designItems.image);
        });
        $('ckDesignScale').addEventListener('input', function (event) {
            var item = self._designItems[self._selectedDesignKey];
            if (!item) return;
            self._setDesignScale(item, event.target.value, ($('ckDesignScaleText') || {}).checked);
            $('ckDesignScaleValue').textContent = Math.round(item.scale * 100) + '%';
        });
        $('ckDesignScaleText').addEventListener('change', function (event) {
            var item = self._designItems[self._selectedDesignKey];
            if (!item) return;
            self._setDesignScale(item, item.scale, event.target.checked);
        });
        this._setDesignMode(true);
    };

    /* ---- 全テーマ共通のフリーコメント ---- */
    CardKit.prototype._buildFreeComment = function () {
        if (!this.card || $('displayFreeComment')) return;

        var comment = document.createElement('div');
        comment.id = 'displayFreeComment';
        comment.className = 'ck-free-comment ck-fit ck-fit-box';
        comment.dataset.position = 'auto';
        comment.dataset.fitMin = '0.58';
        comment.hidden = true;
        this.card.appendChild(comment);

        var panel = document.querySelector('.editor-panel') || document.querySelector('.ck-panel');
        if (!panel || $('freeCommentInput')) return;

        var field = document.createElement('section');
        field.className = 'ck-field ck-free-comment-controls';
        field.innerHTML =
            '<label class="ck-label" for="freeCommentInput">💬 フリーコメント</label>' +
            '<textarea id="freeCommentInput" class="ck-input" rows="3" maxlength="200" placeholder="展示物の補足、制作メモ、SNSなどを自由に入力"></textarea>' +
            '<div class="ck-free-comment-options">' +
            '<label><span>配置</span><select id="freeCommentPosition" class="ck-input">' +
            '<option value="auto" selected>自動（おすすめ）</option>' +
            '<option value="bottom-left">左下</option><option value="bottom-right">右下</option>' +
            '<option value="top-left">左上</option><option value="top-right">右上</option>' +
            '</select></label>' +
            '<label><span>文字サイズ</span><select id="freeCommentSize" class="ck-input">' +
            '<option value="6">小</option><option value="8" selected>標準</option><option value="10">大</option>' +
            '</select></label></div>' +
            '<small class="ck-help">空欄ならカードには表示されません。改行もそのまま反映されます。</small>';

        field.querySelector('#freeCommentInput').value = DEFAULT_FREE_COMMENT;

        var exportBlock = panel.querySelector('#btnExport');
        while (exportBlock && exportBlock.parentElement !== panel) exportBlock = exportBlock.parentElement;
        panel.insertBefore(field, exportBlock || null);
    };

    CardKit.prototype._syncFreeComment = function () {
        var target = $('displayFreeComment');
        var input = $('freeCommentInput');
        if (!target || !input) return;
        var value = input.value.trim();
        target.innerText = value;
        target.hidden = !value;
        target.dataset.position = ($('freeCommentPosition') || {}).value || 'auto';
        target.style.fontSize = (($('freeCommentSize') || {}).value || 8) + 'pt';
        delete target.dataset.ckBase;
    };

    CardKit.prototype._syncFreeCommentFont = function () {
        var target = $('displayFreeComment');
        if (!target) return;
        var fontSelects = (this.cfg.selects || []).filter(function (select) {
            return /font/i.test([select.cssVar, select.key, select.input].join(' '));
        });
        var selected = fontSelects.filter(function (select) {
            return /main.?font|font.?main/i.test([select.cssVar, select.key, select.input].join(' '));
        })[0] || fontSelects[0];
        var input = selected && $(selected.input);
        if (input && input.value) {
            target.style.fontFamily = input.value;
            delete target.dataset.ckBase;
        } else {
            target.style.removeProperty('font-family');
        }
    };

    /*
     * 自動配置では、テーマ内の文字・画像・情報パネルと重ならない空き領域を探す。
     * 位置はカードに対する百分率で確定するため、そのままPNGへ引き継がれる。
     */
    CardKit.prototype._placeFreeComment = function () {
        var target = $('displayFreeComment');
        if (!target || target.hidden || !this.card) return;

        ['left', 'right', 'top', 'bottom', 'width'].forEach(function (prop) {
            target.style.removeProperty(prop);
        });
        if (target.dataset.position !== 'auto') return;

        // 全面に情報が詰まったテーマは、単純な衝突判定だけでは空白と
        // パネル内部の余白を区別できないため、デザイン済みの安全領域を使う。
        var themePreset = {
            RPG: { left: 8, top: 62, width: 84 },
            SKETCH: { left: 4, top: 34, width: 26 },
            TCG: { left: 38, top: 34, width: 58 }
        }[String((this.cfg || {}).theme || '').toUpperCase()];
        if (themePreset) {
            target.style.left = themePreset.left + '%';
            target.style.top = themePreset.top + '%';
            target.style.right = 'auto';
            target.style.bottom = 'auto';
            target.style.width = themePreset.width + '%';
            return;
        }

        var card = this.card;
        var cardRect = card.getBoundingClientRect();
        if (!cardRect.width || !cardRect.height) return;

        var blockers = Array.prototype.filter.call(card.querySelectorAll('*'), function (el) {
            if (el === target || target.contains(el) || el.closest('.ck-watermark') ||
                el.closest('.ck-design-resize-overlay')) return false;
            var style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
            var rect = el.getBoundingClientRect();
            if (!rect.width || !rect.height) return false;
            var areaRatio = rect.width * rect.height / (cardRect.width * cardRect.height);
            if (areaRatio >= 0.55) return false; // カード全面の背景・レイアウト枠は除外

            var leafText = el.children.length === 0 && el.textContent.trim();
            var media = /^(IMG|SVG|CANVAS|VIDEO)$/.test(el.tagName);
            var bg = style.backgroundColor;
            var hasBg = bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0(?:\.0+)?\)$/.test(bg);
            var hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(function (side) {
                return parseFloat(style['border' + side + 'Width']) > 0;
            });
            return Boolean(leafText || media || hasBg || hasBorder);
        });

        var candidates = [];
        [82, 72, 62, 52, 42, 32, 22, 12].forEach(function (top) {
            candidates.push({ left: 4, top: top });
            candidates.push({ left: 38, top: top });
        });

        var best = null;
        candidates.forEach(function (candidate, index) {
            target.style.left = candidate.left + '%';
            target.style.top = candidate.top + '%';
            target.style.right = 'auto';
            target.style.bottom = 'auto';
            target.style.width = '58%';

            var rect = target.getBoundingClientRect();
            var overflow = Math.max(0, cardRect.left - rect.left) + Math.max(0, rect.right - cardRect.right) +
                Math.max(0, cardRect.top - rect.top) + Math.max(0, rect.bottom - cardRect.bottom);
            var overlap = 0;
            blockers.forEach(function (el) {
                var other = el.getBoundingClientRect();
                var w = Math.max(0, Math.min(rect.right, other.right) - Math.max(rect.left, other.left));
                var h = Math.max(0, Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top));
                overlap += w * h;
            });
            var score = overlap + overflow * Math.max(rect.width, rect.height) + index * 0.001;
            if (!best || score < best.score) best = { left: candidate.left, top: candidate.top, score: score };
        });

        if (best) {
            target.style.left = best.left + '%';
            target.style.top = best.top + '%';
            target.style.right = 'auto';
            target.style.bottom = 'auto';
            target.style.width = '58%';
        }
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
            '<button data-zoom="1.0" class="ck-zoom-btn active">画面に合わせる</button>' +
            '<button data-zoom="1.3" class="ck-zoom-btn">1.3× 大</button>' +
            '<button data-zoom="1.6" class="ck-zoom-btn">1.6× 特大</button>' +
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

    CardKit.prototype._buildPreviewStage = function () {
        if (!this.card || this.card.parentElement.classList.contains('ck-card-stage')) {
            this.stage = this.card && this.card.parentElement;
            return;
        }
        var stage = document.createElement('div');
        stage.className = 'ck-card-stage';
        this.card.parentNode.insertBefore(stage, this.card);
        stage.appendChild(this.card);
        this.stage = stage;
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

        card.style.transformOrigin = 'top left';
        card.style.transform = 'scale(' + scale + ')';
        if (this.stage) {
            this.stage.style.width = Math.ceil(natW * scale) + 'px';
            this.stage.style.height = Math.ceil(natH * scale) + 'px';
        }
        var headerPad = area.querySelector('.ck-zoom-bar') ? 48 : 16;
        area.style.height = Math.ceil(natH * scale + pad + headerPad) + 'px';
        this._scale = scale;
        this._updateDesignOverlay();
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
            if (this._imageRenderPromise) await this._imageRenderPromise;
            this._placeFreeComment();
            this.autofit(); // 実フォントが載った状態でもう一度詰め直す

            // 表示用スケールだけを一時的に外す。テーマ固有の影やフィルターは
            // PNGとの差を生まないよう、そのまま保持する。
            card.classList.add('ck-exporting');
            card.style.transform = 'none';
            card.style.transformOrigin = 'top left';
            await nextFrame();
            this._placeFreeComment();

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
            // 「この画素数で選択した実寸」になる物理解像度を書き込む
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
                '<span style="font-size:9.5px;opacity:0.85" id="cardSizeDimDisplay">127 × 89 mm</span>' +
                '</label>' +
                '<select id="cardSizeSelect" class="ck-input" style="width:100%;margin-top:4px;padding:6px;font-weight:700;cursor:pointer">' +
                '<option value="127x89" selected>写真 L判 (127 × 89 mm) — 推奨</option>' +
                '<option value="152x102">KGサイズ / はがき (152 × 102 mm) — L判より大きめ</option>' +
                '<option value="178x127">写真 2L判 (178 × 127 mm)</option>' +
                '<option value="210x148">A5サイズ (210 × 148 mm) — 大きめ展示向け</option>' +
                '<option value="91x55">名刺サイズ (91 × 55 mm) — コンパクト</option>' +
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
        this._buildPreviewStage();
        this._buildSizeSelector();
        this._prepareLongTextFields();
        this._buildFreeComment();
        this.setSize(this.widthMm, this.heightMm);

        var syncHandler = function () { self._syncFreeComment(); self.sync(); };
        var panel = document.querySelector('.editor-panel') || document.querySelector('.ck-panel');
        if (panel) {
            ['input', 'change', 'keyup', 'compositionend'].forEach(function (evtType) {
                panel.addEventListener(evtType, syncHandler);
            });
        }
        (cfg.fields || []).forEach(function (f) {
            var el = $(f.input);
            if (el) {
                el.addEventListener('input', syncHandler);
                el.addEventListener('change', syncHandler);
                el.addEventListener('keyup', syncHandler);
            }
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
            [img.posX, img.posY].forEach(function (id) {
                var el = $(id);
                if (el) el.addEventListener('input', function () { self.applyImageTransform(true); });
            });
            var imageScale = $(img.scale);
            if (imageScale) imageScale.addEventListener('input', function () { self.applyImageTransform(false); });
            var mul = $(img.multiply);
            if (mul) mul.addEventListener('change', function () { self.applyImageTransform(true); });
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
        this._buildDesignEditor();
        if (cfg.image) this.applyImageTransform();
        this._syncFreeComment();
        this.sync();
        this.fit();
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () {
                self._placeFreeComment();
                self.autofit();
                self._placeFreeComment();
                self.fit();
            });
        }
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
