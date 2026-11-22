// 1.5.0-lv.2 「기억 정리는 가볍게 생각(추론 low)」: every memory-model call asks for low reasoning through the host's per-request `reasoning`
// override (src/services/generation/direct-generation.ts + reasoning.ts in the Lumiverse source), unless the connection says how it thinks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './env.js';
import { ownReasoning, reasoningIntent, hostReasoning, saysHow } from '../src/adapter/engine.js';

const LOW = { source: 'custom', apiReasoning: true, effort: 'low' };
const conn = (id, over = {}) => ({ id, name: id, provider: 'openai', api_url: '', model: 'm-' + id, preset_id: null, is_default: false, has_api_key: true, metadata: {}, reasoning_bindings: null, created_at: 1, updated_at: 1, ...over });
async function ask(e, id, { signal } = {}) {
    if (e.f.state.summarization === undefined) e.f.state.summarization = {};   // the frontend bridge answers (reads the user's settings)
    e.f.model = async () => '{"ok":true}';
    const model = await e.um.u.run(() => e.um.svc._test.memoryModel(id));
    if (signal) model.signal = signal;
    return e.um.u.run(() => e.um.svc._test.askModel(model, [{ role: 'user', content: 'hi' }]));
}
const calls = e => e.f.state.modelCalls;

for (const provider of ['openai', 'nanogpt', 'openrouter', 'google', 'anthropic', 'custom']) {
    test(`${provider}: asks the host for low reasoning (the host writes it in the provider's own words)`, async () => {
        const e = makeEnv();
        e.f.connections.push(conn('c1', { provider }));
        await ask(e, 'c1');
        assert.deepEqual(calls(e).map(c => c.reasoning), [LOW]);
        assert.equal(calls(e)[0].connection_id, 'c1');
    });
}

test('Gemma 4 (upstream\'s own light request) goes the same way, once', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('g', { provider: 'google', model: 'gemma-4-31b-it' }));
    await ask(e, 'g');
    assert.deepEqual(calls(e).map(c => c.reasoning), [LOW]);
});

test('DeepSeek: thinking off (as upstream does), not low', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('d', { provider: 'deepseek', model: 'deepseek-chat' }));
    await ask(e, 'd');
    assert.deepEqual(calls(e).map(c => c.reasoning), [{ source: 'off' }]);
});

test('the connection\'s own reasoning setting wins for every model (nothing is sent)', async () => {
    const e = makeEnv();
    const binding = { settings: { apiReasoning: true, reasoningEffort: 'high', thinkingDisplay: 'auto', prefix: '', suffix: '', autoParse: true, keepInHistory: 0 } };
    e.f.connections.push(conn('b1', { reasoning_bindings: binding, metadata: { reasoningBindings: binding } }), conn('b2', { provider: 'deepseek', reasoning_bindings: binding }), conn('m1', { metadata: { thinking_budget: 2048 } }));
    for (const id of ['b1', 'b2', 'm1']) await ask(e, id);
    assert.deepEqual(calls(e).map(c => 'reasoning' in c), [false, false, false]);
    assert.equal(ownReasoning(conn('x')).marker, undefined);
    assert.ok(ownReasoning(conn('x', { reasoning_bindings: binding })).marker.includes('reasoningBindings'));
    assert.equal(ownReasoning(conn('x', { metadata: { reasoningBindings: binding } })).how, true, 'a host that gives only the metadata blob');
});

test('switch off: no reasoning key at all, DeepSeek included (the call is what it was before)', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('o1'), conn('o2', { provider: 'deepseek' }));
    await e.um.u.run(() => e.um.saveLvSettings({ lightReasoning: false }));
    assert.equal(e.um.lvSettings().lightReasoning, false);
    for (const id of ['o1', 'o2']) await ask(e, id);
    assert.deepEqual(calls(e).map(c => Object.keys(c).sort().join()), ['connection_id,messages,parameters', 'connection_id,messages,parameters']);
    await e.um.u.run(() => e.um.saveLvSettings({ lightReasoning: true }));
    await ask(e, 'o1');
    assert.deepEqual(calls(e).at(-1).reasoning, LOW);
});

test('a site that refuses it: asked again without, and that connection is not sent it again', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('r1'), conn('r2'));
    e.f.state.modelFail = input => (input.reasoning ? 'Unrecognized request argument supplied: reasoning_effort' : null) || undefined;
    const real = e.f.api.generate.quiet;
    e.f.api.generate.quiet = async input => { if (input.reasoning) { e.f.state.modelCalls.push({ connection_id: input.connection_id, reasoning: input.reasoning, refused: true }); throw new Error('Unrecognized request argument supplied: reasoning_effort'); } e.f.state.modelFail = null; return real(input); };
    await ask(e, 'r1');
    assert.deepEqual(calls(e).map(c => [c.connection_id, !!c.reasoning]), [['r1', true], ['r1', false]], 'refused once, then the same call without');
    await ask(e, 'r1');
    assert.deepEqual(calls(e).slice(2).map(c => [c.connection_id, !!c.reasoning]), [['r1', false]], 'remembered: not sent again');
    await ask(e, 'r2');
    assert.equal(!!calls(e).at(-2).reasoning, true, 'another connection is still asked once');
    assert.ok(e.logs.some(l => /reasoning request refused/.test(l)));
});

test('a JSON-mode refusal is not taken for a reasoning refusal (and upstream\'s own retry still works)', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('j'));
    const real = e.f.api.generate.quiet;
    e.f.api.generate.quiet = async input => { if (input.parameters?.response_format) throw new Error('response_format json_object is not supported with this effort'); return real(input); };
    await ask(e, 'j');
    const withReasoning = calls(e).filter(c => c.reasoning);
    assert.equal(withReasoning.length, 1, 'only the retry without JSON mode reached the model');
    await ask(e, 'j');
    assert.ok(calls(e).at(-1).reasoning, 'still asked for low: the connection was not marked refused');
});

test('another error, an abort: thrown as it is', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('x'));
    e.f.api.generate.quiet = async () => { throw new Error('rate limit exceeded'); };
    await assert.rejects(ask(e, 'x'), /rate limit/);
    const ac = new AbortController(); ac.abort();
    e.f.api.generate.quiet = async () => { throw new Error('thinking aborted'); };
    await assert.rejects(ask(e, 'x', { signal: ac.signal }));
});

test('intent words', () => {
    assert.equal(reasoningIntent({ customParameters: { thinking: { type: 'disabled' } } }), 'off');
    assert.equal(reasoningIntent({ reasoningEffort: 'low', enableThinking: true }), 'low');
    assert.equal(reasoningIntent({ customParameters: { reasoning: { effort: 'low' } } }), 'low');
    assert.equal(reasoningIntent({}), null);
    assert.deepEqual(hostReasoning('low'), LOW);
});

test('the user\'s saved global reasoning setting is followed when the connection has no binding (the host would use it); unsaved = low; unreadable = nothing', async () => {
    const e = makeEnv();
    e.f.connections.push(conn('g'));
    const run = async g => { e.f.state.globalReasoning = g; e.f.state.summarization = {}; await e.manager.host.globalReasoning('u1', Date.now() + 60_000); const n = calls(e).length; await ask(e, 'g'); return calls(e).slice(n).map(c => c.reasoning); };
    // the 30 s memory of the read is passed by asking with a later clock above; each case uses a fresh manager state
    assert.deepEqual(await run({ saved: false }), [LOW], 'nothing saved anywhere: low');
    const f2 = makeEnv(); f2.f.connections.push(conn('g'));
    f2.f.state.summarization = {}; f2.f.state.globalReasoning = { saved: true, apiReasoning: true, reasoningEffort: 'high' };
    await ask(f2, 'g'); assert.deepEqual(calls(f2).map(c => 'reasoning' in c), [false], 'saved effort high: not overridden');
    const f3 = makeEnv(); f3.f.connections.push(conn('g'));
    f3.f.state.summarization = {}; f3.f.state.globalReasoning = { saved: true, apiReasoning: false, reasoningEffort: 'auto' };
    await ask(f3, 'g'); assert.deepEqual(calls(f3).map(c => 'reasoning' in c), [false], 'saved reasoning off: not turned on');
    const f4 = makeEnv(); f4.f.connections.push(conn('g'));
    f4.f.state.summarization = {}; f4.f.state.globalReasoning = { saved: true, apiReasoning: true, reasoningEffort: 'auto' };
    await ask(f4, 'g'); assert.deepEqual(calls(f4).map(c => c.reasoning), [LOW], 'saved but auto says nothing: low');
    const f5 = makeEnv(); f5.f.connections.push(conn('g'));
    f5.f.state.summarization = null; f5.f.api.generate.quiet = (q => async i => q(i))(f5.f.api.generate.quiet);
    f5.f.model = async () => '{"ok":true}';
    const m5 = await f5.um.u.run(() => f5.um.svc._test.memoryModel('g')); await f5.um.u.run(() => f5.um.svc._test.askModel(m5, [{ role: 'user', content: 'hi' }]));
    assert.deepEqual(calls(f5).map(c => 'reasoning' in c), [false], 'unreadable: conservative, nothing sent');
    // a binding that says "auto" does not consult the global setting and does not say how: low
    const f6 = makeEnv(); const auto = { settings: { apiReasoning: true, reasoningEffort: 'auto' } };
    f6.f.connections.push(conn('g', { reasoning_bindings: auto })); f6.f.state.summarization = null;
    await ask(f6, 'g');
    assert.deepEqual(calls(f6).map(c => c.reasoning), [LOW], 'bound with auto: the global setting is not consulted (even when unreadable)');
    assert.ok(saysHow({ apiReasoning: false }) && !saysHow({ apiReasoning: true, reasoningEffort: 'auto' }) && !saysHow(null));
});
