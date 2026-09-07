import { expect, test } from "bun:test";
import { assertReviewedRuntimeStyleBoundary } from "./build-runtime-style-boundary.ts";

// Exact parsed acquireResource function from the reviewed production graph.
// It contains renderer capability, not an application request to emit a style.
const reviewedFunction = String.raw`function Tk(n,r,a){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+Ln(a.href)+'"]');if(l)return r.instance=l,jt(l),l;var d=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),jt(l),$t(l,"style",d),nu(l,a.precedence,n),r.instance=l;case"stylesheet":d=Ys(a.href);var p=n.querySelector(lo(d));if(p)return r.state.loading|=4,r.instance=p,jt(p),p;l=Ek(a),(d=Qn.get(d))&&md(l,d),p=(n.ownerDocument||n).createElement("link"),jt(p);var k=p;return k._p=new Promise(function(w,j){k.onload=w,k.onerror=j}),$t(p,"link",l),r.state.loading|=4,nu(p,a.precedence,n),r.instance=p;case"script":return p=Fs(a.src),(d=n.querySelector(uo(p)))?(r.instance=d,jt(d),d):(l=a,(d=Qn.get(p))&&(l=g({},a),gd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),jt(d),$t(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,nu(l,a.precedence,n));return r.instance}`;
const evidence = {
  manifest: { name: "react-dom", version: "19.2.8" },
  productionClientSha256: "6cf4932e0c20a4572ae395035ca2e512a42d7d49c1a659fa73d6197069c28df0",
};
const artifact = (text: string) => ({ name: "main.js", text });

test("accepts only the dependency-bound parsed renderer capability", () => {
  expect(() => assertReviewedRuntimeStyleBoundary([artifact(reviewedFunction)], evidence)).not.toThrow();
});

test("rejects extra style creation and CSSOM insertion in any emitted chunk", () => {
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

test("rejects changed resource ownership, branch context, and duplicate capabilities", () => {
  for (const changed of [
    reviewedFunction.replace("n.ownerDocument||n", "document"),
    reviewedFunction.replace("switch(r.type)", "switch(a.type)"),
    reviewedFunction.replace('case"style":', 'case"other":'),
    `${reviewedFunction}\n${reviewedFunction}`,
    'document.createElement("style");',
  ]) {
    expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence))
      .toThrow(/context/u);
  }
});

test("rejects wrong package identity and changed installed renderer bytes", () => {
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

test("keeps explicit StyleX injector bans even without an extra style call", () => {
  for (const marker of ["stylex-inject", "stylexInject", "data-stylex", "stylesheet-group"]) {
    expect(() => assertReviewedRuntimeStyleBoundary([
      artifact(`${reviewedFunction}\nvoid ${JSON.stringify(marker)};`),
    ], evidence)).toThrow(/StyleX runtime injector/u);
  }
});

test("does not accept a string decoy, missing renderer, or malformed JavaScript", () => {
  for (const text of [JSON.stringify(reviewedFunction), "void 0;", `${reviewedFunction}\nfunction {`]) {
    expect(() => assertReviewedRuntimeStyleBoundary([artifact(text)], evidence)).toThrow();
  }
});
