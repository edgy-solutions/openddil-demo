import * as TWEEN from '@tweenjs/tween.js';
const group = new TWEEN.Group();
const obj = { x: 0 };
const t = new TWEEN.Tween(obj, group).to({ x: 1 }, 1000).onComplete(() => console.log("Done!")).start();
console.log("getAll", group.getAll().length);
group.update();
console.log("obj.x after update 1", obj.x);
setTimeout(() => {
  group.update();
  console.log("obj.x after update 2", obj.x);
}, 1100);
