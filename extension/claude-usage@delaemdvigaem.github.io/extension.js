import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DATA_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage.json']);
const MARGIN = 24;
const STALE_AFTER = 10 * 60; // seconds without a poller run before data is marked stale
const MIN_FILL = 8;

const STRINGS = {
    en: {
        title: 'Claude',
        session: 'Session (5 h)',
        weekly: 'Week',
        weeklyModel: 'Week · %s',
        resetsIn: 'resets in %s',
        resetsSoon: 'resets any minute',
        d: 'd', h: 'h', m: 'min',
        noData: 'no data',
        stale: 'data is stale',
        errors: {
            token_expired: 'token expired',
            no_credentials: 'Claude Code not signed in',
            rate_limited: 'rate limited',
            default: 'service unavailable',
        },
    },
    ru: {
        title: 'Claude',
        session: 'Сессия (5 ч)',
        weekly: 'Неделя',
        weeklyModel: 'Неделя · %s',
        resetsIn: 'сброс через %s',
        resetsSoon: 'сброс с минуты на минуту',
        d: 'д', h: 'ч', m: 'мин',
        noData: 'нет данных',
        stale: 'данные устарели',
        errors: {
            token_expired: 'токен истёк',
            no_credentials: 'нет входа в Claude Code',
            rate_limited: 'слишком частые запросы',
            default: 'сервис недоступен',
        },
    },
};

function pickStrings() {
    const isRu = GLib.get_language_names().some(l => l.startsWith('ru'));
    return isRu ? STRINGS.ru : STRINGS.en;
}

function parseTime(iso) {
    if (!iso)
        return null;
    // the API sends microseconds, Date only understands milliseconds
    const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(ms) ? null : ms;
}

function severityClass(severity, percent) {
    if (percent >= 100)
        return 'critical';
    if (['normal', 'ok', 'info'].includes(severity))
        return 'normal';
    if (['warning', 'warn'].includes(severity))
        return 'warning';
    if (severity)
        return 'critical';
    if (percent >= 90)
        return 'critical';
    return percent >= 70 ? 'warning' : 'normal';
}

// Progress bar: the fill is sized during allocation, so it follows the track
// width without touching actor sizes from signal handlers.
const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init() {
        super._init({style_class: 'claude-usage-track', x_expand: true});
        this._share = 0;
        this.fill = new St.Widget({style_class: 'claude-usage-fill'});
        this.add_child(this.fill);
    }

    setPercent(percent) {
        this._share = Math.min(Math.max(percent, 0), 100) / 100;
        this.fill.visible = this._share > 0;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const full = content.x2 - content.x1;
        const width = Math.min(full, Math.max(Math.round(full * this._share), MIN_FILL));
        const fillBox = new Clutter.ActorBox();
        fillBox.set_origin(content.x1, content.y1);
        fillBox.set_size(width, content.y2 - content.y1);
        this.fill.allocate(fillBox);
    }
});

const UsageRow = GObject.registerClass(
class UsageRow extends St.BoxLayout {
    _init(strings) {
        super._init({
            style_class: 'claude-usage-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._strings = strings;
        this._severity = 'normal';
        this._resetsAt = null;

        const top = new St.BoxLayout({x_expand: true});
        this._label = new St.Label({
            style_class: 'claude-usage-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._value = new St.Label({
            style_class: 'claude-usage-percent',
            y_align: Clutter.ActorAlign.END,
        });
        top.add_child(this._label);
        top.add_child(this._value);

        this._track = new UsageBar();

        this._reset = new St.Label({style_class: 'claude-usage-reset'});

        this.add_child(top);
        this.add_child(this._track);
        this.add_child(this._reset);
    }

    update(label, limit) {
        const percent = Number(limit.percent) || 0;
        const severity = severityClass(limit.severity, percent);

        this._label.text = label;
        this._value.text = `${Math.round(percent)} %`;
        for (const actor of [this._track.fill, this._value]) {
            actor.remove_style_class_name(this._severity);
            actor.add_style_class_name(severity);
        }
        this._severity = severity;
        this._track.setPercent(percent);
        this._resetsAt = parseTime(limit.resets_at);
        this.tick();
    }

    // refreshes the countdown; called once a minute
    tick() {
        const s = this._strings;
        if (this._resetsAt === null) {
            this._reset.text = '';
            return;
        }
        const minutes = Math.floor((this._resetsAt - Date.now()) / 60000);
        if (minutes <= 0) {
            this._reset.text = s.resetsSoon;
            return;
        }
        const d = Math.floor(minutes / 1440);
        const h = Math.floor((minutes % 1440) / 60);
        const m = minutes % 60;
        let left;
        if (d > 0)
            left = `${d} ${s.d} ${h} ${s.h}`;
        else if (h > 0)
            left = `${h} ${s.h} ${m} ${s.m}`;
        else
            left = `${m} ${s.m}`;
        this._reset.text = s.resetsIn.replace('%s', left);
    }
});

const UsageWidget = GObject.registerClass(
class UsageWidget extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'claude-usage-widget',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
        });
        this._strings = pickStrings();
        this._snapshot = null;

        const header = new St.BoxLayout({style_class: 'claude-usage-header', x_expand: true});
        this._title = new St.Label({
            style_class: 'claude-usage-title',
            text: this._strings.title,
            x_expand: true,
        });
        this._status = new St.Label({
            style_class: 'claude-usage-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);
        header.add_child(this._status);
        this.add_child(header);

        this._rows = {};
        for (const kind of ['session', 'weekly_all', 'weekly_scoped']) {
            this._rows[kind] = new UsageRow(this._strings);
            this._rows[kind].hide();
            this.add_child(this._rows[kind]);
        }
        this._syncStatus();
    }

    setSnapshot(snapshot) {
        this._snapshot = snapshot;
        const limits = Array.isArray(snapshot?.limits) ? snapshot.limits : [];
        const s = this._strings;

        const scoped = limits
            .filter(l => l.kind === 'weekly_scoped')
            .sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0))[0];
        const picked = {
            session: limits.find(l => l.kind === 'session'),
            weekly_all: limits.find(l => l.kind === 'weekly_all'),
            weekly_scoped: scoped,
        };
        const labels = {
            session: s.session,
            weekly_all: s.weekly,
            weekly_scoped: scoped?.model ? s.weeklyModel.replace('%s', scoped.model) : s.weekly,
        };

        for (const [kind, row] of Object.entries(this._rows)) {
            row.visible = !!picked[kind];
            if (picked[kind])
                row.update(labels[kind], picked[kind]);
        }
        this._syncStatus();
    }

    tick() {
        for (const row of Object.values(this._rows))
            row.tick();
        this._syncStatus();
    }

    _syncStatus() {
        const s = this._strings;
        const snapshot = this._snapshot;
        const dataAt = parseTime(snapshot?.data_at);
        const fetchedAt = parseTime(snapshot?.fetched_at);

        let problem = null;
        if (!snapshot || dataAt === null)
            problem = snapshot?.error ? s.errors[snapshot.error] ?? s.errors.default : s.noData;
        else if (!snapshot.ok)
            problem = s.errors[snapshot.error] ?? s.errors.default;
        else if (fetchedAt === null || Date.now() - fetchedAt > STALE_AFTER * 1000)
            problem = s.stale;

        const time = dataAt === null
            ? null
            : GLib.DateTime.new_from_unix_local(Math.floor(dataAt / 1000)).format('%H:%M');

        this._status.text = [problem, time].filter(Boolean).join(' · ');
        if (problem)
            this._status.add_style_class_name('problem');
        else
            this._status.remove_style_class_name('problem');
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._widget = new UsageWidget();
        Main.layoutManager._backgroundGroup.add_child(this._widget);

        this._widget.connectObject(
            'notify::width', () => this._queueReposition(),
            'notify::height', () => this._queueReposition(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._queueReposition(), this);
        global.display.connectObject(
            'workareas-changed', () => this._queueReposition(), this);
        this._reposition();

        this._file = Gio.File.new_for_path(DATA_FILE);
        try {
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._scheduleReload());
        } catch (e) {
            console.warn(`${this.uuid}: cannot watch ${DATA_FILE}: ${e.message}`);
        }
        this._reload();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._widget.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = null;
        }
        if (this._repositionId) {
            global.compositor.get_laters().remove(this._repositionId);
            this._repositionId = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._monitor?.cancel();
        this._monitor = null;
        this._file = null;

        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._widget?.destroy();
        this._widget = null;
    }

    // size changes are reported mid-allocation, where moving actors is not allowed
    _queueReposition() {
        if (this._repositionId)
            return;
        this._repositionId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._repositionId = null;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    // top-right corner of the primary monitor's work area
    _reposition() {
        const index = Main.layoutManager.primaryIndex;
        if (!this._widget || index < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        this._widget.set_position(
            area.x + area.width - this._widget.width - MARGIN,
            area.y + MARGIN);
    }

    // the poller replaces the file atomically, which produces a burst of events
    _scheduleReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._reloadId = null;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._file.load_contents_async(cancellable, (file, result) => {
            let snapshot = null;
            try {
                const [, bytes] = file.load_contents_finish(result);
                snapshot = JSON.parse(new TextDecoder().decode(bytes));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                // missing or half-written file: keep the widget alive, show "no data"
            }
            if (this._cancellable !== cancellable)
                return;
            this._cancellable = null;
            this._widget?.setSnapshot(snapshot);
        });
    }
}
