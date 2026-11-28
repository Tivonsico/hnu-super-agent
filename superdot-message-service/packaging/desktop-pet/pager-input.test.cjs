// DSH_PET_PACKAGE points to the dsh-pet package directory.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helper = path.join(process.env.DSH_PET_PACKAGE, 'runtime/electron-helper');
const {decideWindowIgnore} = require(path.join(helper, 'pointer-target.js'));

test('paging controls still receive a stationary click after the margin timeout', () => {
  class PetSprite {}
  vm.runInNewContext(readFileSync(path.join(helper, 'sprite/input.js'), 'utf8'), {PetSprite});
  const pet = Object.assign(new PetSprite(), {
    dragState: {active:false}, superdotStack: {hidden:false},
    balanceClickable:()=>false, workClickable:()=>false, whisperClickable:()=>false,
  });
  const bounds = {x:0,y:0,width:350,height:300};
  const margins = {l:55,t:140,r:55};
  const input = {dragging:false,rects:[{x:10,y:5,width:320,height:80}]};
  const ignores = (x,y) => decideWindowIgnore(bounds, {x,y}, true, pet.inputBusy(), 1200, input, margins);
  assert.equal(ignores(300,60), false);
  assert.equal(ignores(5,100), true);
  pet.superdotStack.hidden = true;
  assert.equal(ignores(300,60), true);
});
