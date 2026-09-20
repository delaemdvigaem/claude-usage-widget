// Takes a screenshot of the test shell. org.gnome.Shell.Screenshot only answers
// callers that own one of a few well-known names; on the private test bus that
// name is free, so we take it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const path = ARGV[0];
const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.gnome.SettingsDaemon.MediaKeys', 0, null, conn => {
    // the shell learns about the name owner asynchronously
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        conn.call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot',
            'org.gnome.Shell.Screenshot', 'Screenshot',
            new GLib.Variant('(bbs)', [false, false, path]),
            null, 0, -1, null, (c, res) => {
                try {
                    c.call_finish(res);
                    print(`saved ${path}`);
                } catch (e) {
                    printerr(e.message);
                }
                loop.quit();
            });
        return GLib.SOURCE_REMOVE;
    });
}, null);
loop.run();
