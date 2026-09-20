import test from 'node:test';
import assert from 'node:assert/strict';
const sample={provider:'subscription:codex',complete:true,raw:'A completed answer.',usage:{output_tokens:250}};

test('native output validation separates terminal usage from the enforced byte limit',async()=>{
 const {withinSubscriptionOutputLimit}=await import('../../shared/subscriptionOutput.js');
 assert.equal(withinSubscriptionOutputLimit(sample,128),true);
 assert.equal(withinSubscriptionOutputLimit({...sample,raw:'x'.repeat(262145)},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,raw:''},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,complete:false},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,usage:{output_tokens:0}},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,usage:{output_tokens:Infinity}},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,usage:{output_tokens:-1}},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,provider:'paid_api'},128),false);
 assert.equal(withinSubscriptionOutputLimit(sample,0),false);
});
test('the enforceable Claude output-token budget remains in effect',async()=>{
 const {withinSubscriptionOutputLimit}=await import('../../shared/subscriptionOutput.js');
 assert.equal(withinSubscriptionOutputLimit({...sample,provider:'subscription:claude'},128),false);
 assert.equal(withinSubscriptionOutputLimit({...sample,provider:'subscription:claude',usage:{output_tokens:12}},128),true);
});
