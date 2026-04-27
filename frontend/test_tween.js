import * as TWEEN from '@tweenjs/tween.js';
const group = new TWEEN.Group();
const obj = { x: 0 };
new TWEEN.Tween(obj, group).to({ x: 1 }, 1000).onComplete(() => console.log("Done!")).start();
console.log("group getAll", group.getAll().length);
group.update(500);
console.log(obj.x);
group.update(1000);
console.log(obj.x);
