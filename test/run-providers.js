// Run outside the shell:  gjs test/run-providers.js [--offline]
// Prints the normalised result for each provider. --offline points the HTTP
// session at a dead proxy so the local fallbacks are exercised.
'use strict';

const { GLib, Gio, Soup } = imports.gi;

const here = Gio.File.new_for_path(imports.system.programInvocationName).get_parent();
imports.searchPath.unshift(here.get_parent().get_child('ai-usage@jeo').get_path());
const Providers = imports.providers;

const session = Providers.newSession();
if (ARGV.indexOf('--offline') >= 0)
    session.proxy_uri = Soup.URI.new('http://127.0.0.1:9');

const loop = new GLib.MainLoop(null, false);
const dir = here.get_parent().get_child('ai-usage@jeo').get_path();
Promise.all([Providers.fetchClaude(session), Providers.fetchCodex(session)]).then(async ([claude, codex]) => {
    await Providers.fetchTokens(dir, { claude, codex });
    print('claude', JSON.stringify(claude, null, 1));
    print('codex', JSON.stringify(codex, null, 1));
    loop.quit();
}).catch(e => {
    printerr(e, e.stack);
    loop.quit();
});
loop.run();
