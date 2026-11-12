/* exported init, enable, disable */
'use strict';

const { Clutter, Gio, GLib, GObject, St } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Providers = Me.imports.providers;

const POLL_SECONDS = 120;
const MIN_REFRESH_GAP = 30;
const WARN_PCT = 60;
const CRIT_PCT = 85;

const PROVIDERS = [
    { id: 'claude', name: 'Claude', app: 'Claude Code', fetch: Providers.fetchClaude },
    { id: 'codex', name: 'Codex', app: 'Codex', fetch: Providers.fetchCodex },
];

// One identity hue per provider, stepped for the surface it is drawn on; warn/crit
// replace it as a limit gets close. Checked for colour-blind separation as a set.
const PALETTE = {
    dark: { claude: '#3987e5', codex: '#199e70', warn: '#fab219', crit: '#d03b3b' },
    light: { claude: '#2a78d6', codex: '#1baf7a', warn: '#fab219', crit: '#d03b3b' },
};
const TRACK_ALPHA = 0.24;
const BADGE_ALPHA = 0.18;

// install.sh can load a new copy of this file into a running shell, and GType names
// cannot be registered twice in one process.
const TYPE_TAG = GLib.get_monotonic_time();

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function meterColor(palette, id, pct) {
    if (pct !== null && pct >= CRIT_PCT)
        return palette.crit;
    if (pct !== null && pct >= WARN_PCT)
        return palette.warn;
    return palette[id];
}

function statusWord(pct) {
    if (pct === null || pct < WARN_PCT)
        return '';
    if (pct >= 100)
        return 'Limit reached';
    return pct >= CRIT_PCT ? 'Near limit' : 'High';
}

// The foreground colour says which kind of surface the theme draws this actor on.
function onDarkSurface(actor, fallback) {
    if (!actor.mapped)
        return fallback;
    const c = actor.get_theme_node().get_foreground_color();
    return (0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue) / 255 > 0.5;
}

function fmtPct(pct) {
    return pct === null ? '–' : `${Math.round(pct)}%`;
}

function fmtCount(n) {
    if (n < 1000)
        return String(n);
    for (const [unit, size] of [['K', 1e3], ['M', 1e6], ['B', 1e9]]) {
        if (n < size * 1000 || unit === 'B') {
            const v = n / size;
            return (v < 100 ? v.toFixed(1) : String(Math.round(v))) + unit;
        }
    }
    return String(n);
}

function fmtTokens(win) {
    if (!win.tokens)
        return '';
    const cached = win.tokens.cached > 0 ? ` · ${fmtCount(win.tokens.cached)} cached` : '';
    return `${fmtCount(win.tokens.fresh)} tokens${cached}`;
}

function fmtReset(win) {
    if (win.pct === null)
        return '';
    if (win.resetsAt === null)
        return 'Not started';
    const left = win.resetsAt - nowSec();
    if (left <= 0)
        return 'Resetting…';
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    if (left < 3600)
        return `Resets in ${Math.max(1, m)}m`;
    if (left < 86400)
        return `Resets in ${h}h ${String(m).padStart(2, '0')}m`;
    return GLib.DateTime.new_from_unix_local(win.resetsAt).format('Resets %a %H:%M');
}

function fmtAgo(t) {
    const d = nowSec() - t;
    if (d < 60)
        return 'just now';
    if (d < 3600)
        return `${Math.floor(d / 60)}m ago`;
    if (d < 86400)
        return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
}

function glyph(id, size) {
    return new St.Icon({
        gicon: Gio.icon_new_for_string(`${Me.path}/icons/${id}-symbolic.svg`),
        icon_size: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Gives its one child the leading `fraction` of the width, whatever width that turns out to be.
const MeterLayout = GObject.registerClass({
    GTypeName: `AiUsageMeterLayout_${TYPE_TAG}`,
}, class MeterLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        this.fraction = 0;
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box, flags) {
        const child = container.get_first_child();
        if (!child)
            return;
        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;
        // Never narrower than the height, so the rounded ends still draw.
        const fill = this.fraction > 0
            ? Math.min(width, Math.max(height, Math.round(width * this.fraction)))
            : 0;
        const childBox = new Clutter.ActorBox();
        childBox.x1 = box.x1;
        childBox.y1 = box.y1;
        childBox.x2 = box.x1 + fill;
        childBox.y2 = box.y2;
        child.allocate(childBox, flags);
    }
});

class Meter {
    // width null: stretch to the parent's width
    constructor(width, height) {
        this._radius = height / 2;
        this._layout = new MeterLayout();
        const props = {
            layout_manager: this._layout,
            height,
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (width === null)
            props.x_expand = true;
        else
            props.width = width;
        this.actor = new St.Widget(props);
        this._fill = new St.Widget();
        this.actor.add_child(this._fill);
    }

    set(pct, color) {
        const p = pct === null ? 0 : Math.max(0, Math.min(100, pct));
        this._layout.fraction = p / 100;
        this._layout.layout_changed();
        this._fill.visible = p > 0;
        const radius = `border-radius: ${this._radius}px;`;
        this.actor.style = `background-color: ${rgba(color, TRACK_ALPHA)}; ${radius}`;
        this._fill.style = `background-color: ${color}; ${radius}`;
    }
}

function buildChip(provider) {
    const box = new St.BoxLayout({ style_class: 'aiu-chip', y_align: Clutter.ActorAlign.CENTER });
    const icon = glyph(provider.id, 14);
    const meter = new Meter(32, 6);
    const label = new St.Label({
        text: '–',
        style_class: 'aiu-chip-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(icon);
    box.add_child(meter.actor);
    box.add_child(label);
    return { actor: box, icon, meter, label };
}

function buildRow(title) {
    const box = new St.BoxLayout({ vertical: true, style_class: 'aiu-row' });
    const head = new St.BoxLayout();
    const pct = new St.Label({ style_class: 'aiu-row-pct', y_align: Clutter.ActorAlign.END });
    head.add_child(new St.Label({
        text: title,
        style_class: 'aiu-row-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.END,
    }));
    head.add_child(pct);
    const meter = new Meter(null, 8);
    const foot = new St.BoxLayout({ style_class: 'aiu-row-foot' });
    const reset = new St.Label({ style_class: 'aiu-dim', opacity: 170, x_expand: true });
    const tokens = new St.Label({ style_class: 'aiu-dim', opacity: 170 });
    foot.add_child(reset);
    foot.add_child(tokens);
    box.add_child(head);
    box.add_child(meter.actor);
    box.add_child(foot);
    return { actor: box, pct, meter, reset, tokens };
}

function buildCard(provider) {
    const box = new St.BoxLayout({ vertical: true, style_class: 'aiu-card' });
    const head = new St.BoxLayout({ style_class: 'aiu-card-head' });
    const icon = glyph(provider.id, 18);
    const badge = new St.Label({
        style_class: 'aiu-badge',
        visible: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    head.add_child(icon);
    head.add_child(new St.Label({
        text: provider.name,
        style_class: 'aiu-card-name',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    head.add_child(badge);

    const session = buildRow('5-hour limit');
    const weekly = buildRow('Weekly limit');
    const note = new St.Label({ style_class: 'aiu-dim', opacity: 170, visible: false });

    box.add_child(head);
    box.add_child(session.actor);
    box.add_child(weekly.actor);
    box.add_child(note);
    return { actor: box, icon, badge, session, weekly, note };
}

function noteText(provider, data) {
    const signIn = `Sign-in expired — open ${provider.app} once`;
    if (!data.ok)
        return data.error === 'auth' ? signIn : 'No data yet';
    if (data.source !== 'local')
        return '';
    const age = data.fetchedAt ? ` · cached ${fmtAgo(data.fetchedAt)}` : ' · cached';
    return (data.error === 'auth' ? signIn : 'Offline') + age;
}

const Indicator = GObject.registerClass({
    GTypeName: `AiUsageIndicator_${TYPE_TAG}`,
}, class AiUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'AI Usage');

        this._session = Providers.newSession();
        this._data = {};
        this._busy = false;
        this._lastRefresh = 0;
        this._destroyed = false;

        const panelBox = new St.BoxLayout({ style_class: 'aiu-panel' });
        this.add_child(panelBox);

        // Plain actors rather than menu items: these rows are not selectable, and
        // non-reactive menu items are drawn greyed out with one-sided padding.
        const popup = new St.BoxLayout({ vertical: true, style_class: 'aiu-popup' });
        popup._delegate = null; // the menu looks this up on every child of its box
        this.menu.box.add_child(popup);
        this._popup = popup;

        this._interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._interfaceChanged = this._interface.connect('changed', (settings, key) => {
            if (key === 'gtk-theme' || key === 'color-scheme') {
                this._applyOsTheme();
                this._render();
            }
        });
        this._applyOsTheme();

        this._chips = {};
        this._cards = {};
        PROVIDERS.forEach((p, i) => {
            this._chips[p.id] = buildChip(p);
            panelBox.add_child(this._chips[p.id].actor);
            this._cards[p.id] = buildCard(p);
            if (i > 0)
                popup.add_child(new St.Widget({ style_class: 'aiu-divider', height: 1 }));
            popup.add_child(this._cards[p.id].actor);
        });

        popup.add_child(new St.Widget({ style_class: 'aiu-divider', height: 1 }));
        const footer = new St.BoxLayout({ style_class: 'aiu-footer' });
        this._updated = new St.Label({
            style_class: 'aiu-dim',
            opacity: 170,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const refresh = new St.Button({
            label: 'Refresh',
            style_class: 'aiu-refresh',
            can_focus: true,
        });
        refresh.connect('clicked', () => this._refresh(true));
        footer.add_child(this._updated);
        footer.add_child(refresh);
        popup.add_child(footer);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._render();
                this._refresh(false);
            }
        });

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh(true);
            return GLib.SOURCE_CONTINUE;
        });

        this._render();
        this._refresh(true);
    }

    _applyOsTheme() {
        // color-scheme only exists on newer GNOME; older ones switch the GTK theme instead.
        const hasScheme = this._interface.settings_schema.has_key('color-scheme');
        this._osDark = hasScheme && this._interface.get_string('color-scheme') === 'prefer-dark' ||
            /dark/i.test(this._interface.get_string('gtk-theme'));

        // The shell theme draws popups light whatever the OS setting is, so dark mode
        // recolours the bubble (see stylesheet.css). A class, because the menu
        // overwrites the bubble's inline style each time it opens.
        const bubble = this.menu._boxPointer;
        if (this._osDark) {
            bubble.add_style_class_name('aiu-dark-bubble');
            this._popup.add_style_class_name('aiu-dark-popup');
        } else {
            bubble.remove_style_class_name('aiu-dark-bubble');
            this._popup.remove_style_class_name('aiu-dark-popup');
        }
        if (bubble._border)
            bubble._border.queue_repaint();
    }

    _refresh(force) {
        if (this._busy || this._destroyed)
            return;
        if (!force && nowSec() - this._lastRefresh < MIN_REFRESH_GAP)
            return;
        this._busy = true;
        this._updated.text = 'Updating…';
        Promise.all(PROVIDERS.map(p => p.fetch(this._session))).then(async results => {
            const data = {};
            PROVIDERS.forEach((p, i) => (data[p.id] = results[i]));
            await Providers.fetchTokens(Me.path, data);
            this._data = data;
        }).catch(e => {
            logError(e, 'ai-usage');
        }).then(() => {
            this._busy = false;
            if (this._destroyed)
                return;
            this._lastRefresh = nowSec();
            this._render();
        });
    }

    _render() {
        const panel = PALETTE[onDarkSurface(this, true) ? 'dark' : 'light'];
        const popup = PALETTE[this._osDark || onDarkSurface(this.menu.box, false) ? 'dark' : 'light'];

        for (const p of PROVIDERS) {
            const data = this._data[p.id];
            const chip = this._chips[p.id];
            const card = this._cards[p.id];
            const sessionPct = data ? data.session.pct : null;

            chip.icon.style = `color: ${panel[p.id]};`;
            chip.meter.set(sessionPct, meterColor(panel, p.id, sessionPct));
            chip.label.text = fmtPct(sessionPct);

            card.icon.style = `color: ${popup[p.id]};`;
            card.badge.style = `background-color: ${rgba(popup[p.id], BADGE_ALPHA)};`;
            card.badge.text = data && data.plan ? data.plan : '';
            card.badge.visible = card.badge.text !== '';

            for (const key of ['session', 'weekly']) {
                const win = data ? data[key] : { pct: null, resetsAt: null };
                card[key].meter.set(win.pct, meterColor(popup, p.id, win.pct));
                card[key].pct.text = fmtPct(win.pct);
                card[key].reset.text = [statusWord(win.pct), fmtReset(win)].filter(s => s).join(' · ');
                card[key].tokens.text = fmtTokens(win);
            }

            const note = data ? noteText(p, data) : '';
            card.note.text = note;
            card.note.visible = note !== '';
        }
        if (!this._busy)
            this._updated.text = this._lastRefresh ? `Updated ${fmtAgo(this._lastRefresh)}` : '';
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        this._session.abort();
        this._interface.disconnect(this._interfaceChanged);
        super._onDestroy();
    }
});

let indicator = null;

function init() {
}

function enable() {
    indicator = new Indicator();
    Main.panel.addToStatusArea('ai-usage', indicator, 0, 'right');
}

function disable() {
    if (indicator) {
        indicator.destroy();
        indicator = null;
    }
}
