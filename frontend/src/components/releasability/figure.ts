// =============================================================================
// Figure helpers for the released-records pane
// =============================================================================
// A released record can cite an illustrated-parts figure (`<ICN>.svg`, served
// session-gated at /figures/) and name one object in it. The figure's objects are
// named by their applicationStructureIdent (the object's `id`), and the record
// names the object by that ident. The file is
// operator-mounted, not authored here, and its markup is injected into the
// page, so `prepareFigure` treats it as untrusted: it parses, strips
// everything that can run script or reach off-document, then marks the
// named object. The figure's own <style> already styles `.hotspot.active`,
// so highlighting is just adding that class.
//
// Runs in the browser (DOMParser / XMLSerializer); tests run it under jsdom.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A figure number that is safe to put in a URL path: a plain token, no
 *  separators, no traversal. Anything else gets no figure control at all. */
export function isSafeIcn(icn: unknown): icn is string {
  return typeof icn === 'string' && ICN_RE.test(icn) && !icn.includes('..');
}

export function figureUrl(icn: string): string {
  return `/figures/${icn}.svg`;
}

/** Elements dropped outright, with their children. */
const DROPPED = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'a'];

function hrefOf(el: Element): string | null {
  return el.getAttribute('href') ?? el.getAttribute('xlink:href');
}

/** Parses, sanitizes and (optionally) highlights a figure. Returns null when
 *  the text is not a well-formed SVG document. `found` says whether
 *  `applicationStructureIdent` named an object in the figure. */
export function prepareFigure(
  svgText: string,
  applicationStructureIdent: string | null,
): { svg: string; found: boolean } | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) return null;

  // Snapshot first: removing while walking a live list skips nodes.
  const all = [...doc.querySelectorAll('*')];
  for (const el of all) {
    if (!el.isConnected || el === root) continue;
    const name = el.localName.toLowerCase();
    const href = hrefOf(el);
    if (DROPPED.includes(name)) {
      el.remove();
    } else if (name === 'image') {
      if (href === null || !(href.startsWith('#') || href.startsWith('data:image/'))) el.remove();
    } else if (name === 'use') {
      if (href === null || !href.startsWith('#')) el.remove();
    } else if (name === 'style') {
      const text = el.textContent ?? '';
      if (/@import/i.test(text) || /url\(/i.test(text)) el.remove();
    }
  }

  for (const el of [root, ...doc.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((n === 'href' || n === 'xlink:href') && !attr.value.startsWith('#')) {
        // A data:image/ href is only kept on <image>; elsewhere it is not a
        // same-document reference.
        if (!(el.localName === 'image' && attr.value.startsWith('data:image/'))) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  let found = false;
  if (applicationStructureIdent !== null) {
    // Compared as strings, never built into a selector: the id is record data.
    for (const el of doc.querySelectorAll('[id]')) {
      if (el.getAttribute('id') === applicationStructureIdent) {
        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        if (!cls.includes('active')) cls.push('active');
        el.setAttribute('class', cls.join(' '));
        found = true;
        break;
      }
    }
  }

  return { svg: new XMLSerializer().serializeToString(root), found };
}
