import assert from 'node:assert/strict';
import { hasTicketParams, applyItemParams, findTicketParamsFor } from '../src/ticket-params.js';

const base = {
    novelaimode: 'nai-diffusion-5-full',
    novelai_sampler: 'k_euler_ancestral',
    Schedule: 'karras',
    novelai_steps: 28,
    nai3Scale: 5,
    cfg_rescale: 0,
};

assert.equal(hasTicketParams({}), false);
assert.equal(hasTicketParams({ steps: '24' }), true);
assert.equal(hasTicketParams({ model: 'nai-diffusion-4-5-full' }), true);

const applied = applyItemParams(base, {
    model: 'nai-diffusion-4-5-full',
    sampler: 'k_dpmpp_2s_ancestral',
    schedule: 'native',
    steps: '25',
    cfg: '5.5',
    rescale: '0.2',
});
assert.equal(applied.novelaimode, 'nai-diffusion-4-5-full');
assert.equal(applied.novelai_sampler, 'k_dpmpp_2s_ancestral');
assert.equal(applied.Schedule, 'native');
assert.equal(applied.novelai_steps, 25);
assert.equal(applied.nai3Scale, 5.5);
assert.equal(applied.cfg_rescale, 0.2);
// base settings untouched
assert.equal(base.novelaimode, 'nai-diffusion-5-full');
assert.equal(base.novelai_steps, 28);

// Matching priority: group beats single artist in group; single artist matches when alone
const d = {
    active: { type: 'group', id: 'g1' },
    groups: {
        g1: { id: 'g1', members: [{ artistId: 'a1' }, { artistId: 'a2' }], cfg: '6.2' },
    },
    artists: {
        a1: { id: 'a1', tag: 'artist:foo', cfg: '4.5' },
        a2: { id: 'a2', tag: 'artist:bar' },
    },
};
const M = {
    resolveTicket(data, ref) {
        const item = ref.type === 'group' ? data.groups[ref.id] : data.artists[ref.id];
        return item ? { ...ref, item } : null;
    },
    ticketString(data, ref) {
        if (ref.type === 'artist') return data.artists[ref.id].tag;
        return data.groups[ref.id].members.map(m => data.artists[m.artistId].tag).join(', ');
    },
};

assert.equal(findTicketParamsFor(d, 'artist:foo, artist:bar, 1girl', M)?.cfg, '6.2');
assert.equal(findTicketParamsFor(d, 'artist:foo, 1girl', M)?.cfg, '4.5');
assert.equal(findTicketParamsFor(d, 'artist:other, 1girl', M), null);

console.log('ticket-params tests passed');
