import * as TWEEN from '@tweenjs/tween.js';
const group = new TWEEN.Group();
const obj = { x: 0 };
new TWEEN.Tween(obj, group).to({ x: 1 }, 1000).onComplete(() => console.log("Done!")).start();
console.log("group getAll", group.getAll().length);
group.update();
console.log(obj.x);
setTimeout(() => {
  group.update();
  console.log(obj.x);
}, 500);
