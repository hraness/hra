import { expect, test } from "bun:test";
import { assertReviewedRuntimeStyleBoundary } from "./build-runtime-style-boundary.ts";

// Exact parsed acquireResource functions from the reviewed production
// allocations. They are renderer capability, not requests to emit a style.
const firstReviewedFunction = String.raw`function Tk(n,r,a){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+Ln(a.href)+'"]');if(l)return r.instance=l,jt(l),l;var d=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),jt(l),$t(l,"style",d),nu(l,a.precedence,n),r.instance=l;case"stylesheet":d=Ys(a.href);var p=n.querySelector(lo(d));if(p)return r.state.loading|=4,r.instance=p,jt(p),p;l=Ek(a),(d=Qn.get(d))&&md(l,d),p=(n.ownerDocument||n).createElement("link"),jt(p);var k=p;return k._p=new Promise(function(w,j){k.onload=w,k.onerror=j}),$t(p,"link",l),r.state.loading|=4,nu(p,a.precedence,n),r.instance=p;case"script":return p=Fs(a.src),(d=n.querySelector(uo(p)))?(r.instance=d,jt(d),d):(l=a,(d=Qn.get(p))&&(l=g({},a),gd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),jt(d),$t(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,nu(l,a.precedence,n));return r.instance}`;
const secondReviewedFunction = String.raw`function Rb(n,r,a){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+Pn(a.href)+'"]');if(l)return r.instance=l,Mt(l),l;var d=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),Mt(l),Ut(l,"style",d),ru(l,a.precedence,n),r.instance=l;case"stylesheet":d=Js(a.href);var m=n.querySelector(ho(d));if(m)return r.state.loading|=4,r.instance=m,Mt(m),m;l=Mb(a),(d=Gn.get(d))&&kd(l,d),m=(n.ownerDocument||n).createElement("link"),Mt(m);var k=m;return k._p=new Promise(function(S,O){k.onload=S,k.onerror=O}),Ut(m,"link",l),r.state.loading|=4,ru(m,a.precedence,n),r.instance=m;case"script":return m=ea(a.src),(d=n.querySelector(po(m)))?(r.instance=d,Mt(d),d):(l=a,(d=Gn.get(m))&&(l=g({},a),xd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),Mt(d),Ut(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,ru(l,a.precedence,n));return r.instance}`;
const thirdReviewedFunction = String.raw`function Ib(n,r,o){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+$n(o.href)+'"]');if(l)return r.instance=l,Rt(l),l;var d=y({},o,{"data-href":o.href,"data-precedence":o.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),Rt(l),Bt(l,"style",d),su(l,o.precedence,n),r.instance=l;case"stylesheet":d=to(o.href);var m=n.querySelector(ha(d));if(m)return r.state.loading|=4,r.instance=m,Rt(m),m;l=Mb(o),(d=Kn.get(d))&&vd(l,d),m=(n.ownerDocument||n).createElement("link"),Rt(m);var k=m;return k._p=new Promise(function(S,R){k.onload=S,k.onerror=R}),Bt(m,"link",l),r.state.loading|=4,su(m,o.precedence,n),r.instance=m;case"script":return m=no(o.src),(d=n.querySelector(pa(m)))?(r.instance=d,Rt(d),d):(l=o,(d=Kn.get(m))&&(l=y({},o),Sd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),Rt(d),Bt(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,su(l,o.precedence,n));return r.instance}`;
const reviewedFunctions = [
  { name: "Tk", text: firstReviewedFunction, mark: "jt", properties: "$t", otherMark: "Mt", props: "a", assign: "g" },
  { name: "Rb", text: secondReviewedFunction, mark: "Mt", properties: "Ut", otherMark: "jt", props: "a", assign: "g" },
  { name: "Ib", text: thirdReviewedFunction, mark: "Rt", properties: "Bt", otherMark: "Mt", props: "o", assign: "y" },
] as const;
const evidence = {
  manifest: { name: "react-dom", version: "19.2.8" },
  productionClientSha256: "6cf4932e0c20a4572ae395035ca2e512a42d7d49c1a659fa73d6197069c28df0",
};
const artifact = (text: string) => ({ name: "main.js", text });

for (const { name, text: reviewedFunction, mark, properties, otherMark, props, assign } of reviewedFunctions) {
  test(`${name}: accepts only the dependency-bound parsed renderer capability`, () => {
    expect(() => assertReviewedRuntimeStyleBoundary([artifact(reviewedFunction)], evidence)).not.toThrow();
  });

  test(`${name}: rejects extra style creation and CSSOM insertion in any emitted chunk`, () => {
    for (const call of [
      'document.createElement("style");',
      'document["createElement"]("STYLE");',
      String.raw`document.createElement("\x73tyle");`,
      'sheet.insertRule("body{display:none}");',
      'sheet["insertRule"]("body{display:none}");',
    ]) {
      expect(() => assertReviewedRuntimeStyleBoundary([
        artifact(reviewedFunction), { name: "extra.js", text: call },
      ], evidence)).toThrow(/Unreviewed/u);
    }
  });

  test(`${name}: rejects changed resource ownership, branch context, and duplicate capabilities`, () => {
    for (const changed of [
      reviewedFunction.replace("n.ownerDocument||n", "document"),
      reviewedFunction.replace("switch(r.type)", `switch(${props}.type)`),
      reviewedFunction.replace('case"style":', 'case"other":'),
      `${reviewedFunction}\n${reviewedFunction}`,
      'document.createElement("style");',
    ]) {
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence))
        .toThrow(/context/u);
    }
  });

  test(`${name}: rejects wrong package identity and changed installed renderer bytes`, () => {
    for (const changed of [
      { ...evidence, manifest: { name: "another-package", version: "19.2.8" } },
      { ...evidence, manifest: { name: "react-dom", version: "19.2.9" } },
      { ...evidence, manifest: null },
      { ...evidence, productionClientSha256: "0".repeat(64) },
    ]) {
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(reviewedFunction)], changed))
        .toThrow(/dependency identity/u);
    }
  });

  test(`${name}: keeps explicit StyleX injector bans even without an extra style call`, () => {
    for (const marker of ["stylex-inject", "stylexInject", "data-stylex", "stylesheet-group"]) {
      expect(() => assertReviewedRuntimeStyleBoundary([
        artifact(`${reviewedFunction}\nvoid ${JSON.stringify(marker)};`),
      ], evidence)).toThrow(/StyleX runtime injector/u);
    }
  });

  test(`${name}: does not accept a string decoy, missing renderer, or malformed JavaScript`, () => {
    for (const text of [JSON.stringify(reviewedFunction), "void 0;", `${reviewedFunction}\nfunction {`]) {
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(text)], evidence)).toThrow();
    }
  });

  test(`${name}: rejects unknown allocations, inconsistent helper reuse and binding collisions`, () => {
    for (const changed of [
      reviewedFunction.replace(`function ${name}(`, "function Unreviewed("),
      reviewedFunction.replace(`${mark}(l)`, `${otherMark}(l)`),
      reviewedFunction.replace(`${mark}(l)`, `${properties}(l)`),
      reviewedFunction.replaceAll(`${mark}(`, `${assign}(`),
      reviewedFunction.replaceAll(`${mark}(`, "n("),
      // Swap two helper uses without changing either helper's occurrence count.
      reviewedFunction.replace(`${mark}(l)`, `${properties}(l)`)
        .replace(`${properties}(l,"style",d)`, `${mark}(l,"style",d)`),
    ]) {
      expect(changed).not.toBe(reviewedFunction);
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence)).toThrow(/context/u);
    }
  });

  test(`${name}: rejects changed properties, literals, operators, scope and escaped spellings`, () => {
    const escapedMark = `\\u${mark.charCodeAt(0).toString(16).padStart(4, "0")}${mark.slice(1)}`;
    for (const changed of [
      reviewedFunction.replace(".ownerDocument", ".document"),
      reviewedFunction.replace('"data-href":', '"data-src":'),
      reviewedFunction.replace("precedence:null", "precedence:0"),
      reviewedFunction.replace("r.count++", "r.count--"),
      reviewedFunction.replace("ownerDocument||n", "ownerDocument&&n"),
      reviewedFunction.replace("r.instance===null", "r.instance!==null"),
      reviewedFunction.replace(`(n,r,${props})`, `(r,n,${props})`),
      reviewedFunction.replace("{if(r.count++", `{let ${mark};if(r.count++`),
      `const resource = ${reviewedFunction};`,
      reviewedFunction.replace(`${mark}(l)`, `${escapedMark}(l)`),
      reviewedFunction.replace('createElement("style")', String.raw`createElement("\x73tyle")`),
    ]) {
      expect(changed).not.toBe(reviewedFunction);
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence)).toThrow(/context/u);
    }
  });
}

test("rejects any pair of reviewed allocations occurring together, including separate chunks", () => {
  for (const first of reviewedFunctions) {
    for (const second of reviewedFunctions) {
      if (first === second) continue;
      for (const artifacts of [
        [artifact(`${first.text}\n${second.text}`)],
        [artifact(first.text), { name: "other.js", text: second.text }],
      ]) {
        expect(() => assertReviewedRuntimeStyleBoundary(artifacts, evidence)).toThrow(/Duplicate/u);
      }
    }
  }
});
