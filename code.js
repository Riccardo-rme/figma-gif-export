// Frame to GIF — main thread (Figma sandbox).
// Reads the selection, exports frames as PNG and hands them to the UI,
// which builds the GIF. Kept to plain ES2017 for the plugin sandbox.

var EXPORTABLE = { FRAME: 1, COMPONENT: 1, INSTANCE: 1, GROUP: 1, COMPONENT_SET: 1, SECTION: 1 };
var CHILD_TYPES = { FRAME: 1, COMPONENT: 1, INSTANCE: 1 };
var SETTINGS_KEY = 'frame-to-gif/settings';
var THUMB_SIZE = 80;

var useChildren = false;
var selectionVersion = 0;
var cancelExport = false;
var lastExportIds = [];
var selectionTimer = null;

figma.showUI(__html__, { width: 340, height: 640, themeColors: true, title: 'Frame to GIF' });

function isExportable(node) {
  return !!node && EXPORTABLE[node.type] === 1 && node.visible !== false;
}

function childFrames(node) {
  if (!('children' in node)) return [];
  return node.children.filter(function (c) {
    return CHILD_TYPES[c.type] === 1 && c.visible !== false;
  });
}

// Which nodes become GIF frames for the current selection.
function resolveSelection() {
  var selected = figma.currentPage.selection.filter(isExportable);
  var result = { nodes: selected, container: null, canUseChildren: false };
  if (selected.length !== 1) return result;

  var parent = selected[0];
  var kids = childFrames(parent);
  if (kids.length < 2) return result;

  // Sections and variant sets are always containers; a frame only if asked.
  var forced = parent.type === 'SECTION' || parent.type === 'COMPONENT_SET';
  result.canUseChildren = !forced;
  if (forced || useChildren) {
    result.nodes = kids;
    result.container = parent.name;
  }
  return result;
}

// Index path from the page root, used for "layer order" sorting in the UI.
function layerPath(node) {
  var path = [];
  var n = node;
  while (n.parent && n.type !== 'PAGE') {
    path.unshift(n.parent.children.indexOf(n));
    n = n.parent;
  }
  return path;
}

function describe(node) {
  var box = node.absoluteBoundingBox || { x: node.x, y: node.y, width: node.width, height: node.height };
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(box.width),
    height: Math.round(box.height),
    x: box.x,
    y: box.y,
    layer: layerPath(node)
  };
}

function sendSelection() {
  var version = ++selectionVersion;
  var sel = resolveSelection();
  figma.ui.postMessage({
    type: 'selection',
    version: version,
    frames: sel.nodes.map(describe),
    container: sel.container,
    canUseChildren: sel.canUseChildren,
    useChildren: useChildren
  });
  sendThumbnails(sel.nodes, version);
}

async function sendThumbnails(nodes, version) {
  for (var i = 0; i < nodes.length; i++) {
    if (version !== selectionVersion) return;
    var node = nodes[i];
    try {
      var scale = Math.min(1, THUMB_SIZE / Math.max(node.width, node.height, 1));
      var bytes = await node.exportAsync({
        format: 'PNG',
        useAbsoluteBounds: true,
        constraint: { type: 'SCALE', value: Math.max(scale, 0.01) }
      });
      if (version !== selectionVersion) return;
      figma.ui.postMessage({ type: 'thumb', version: version, id: node.id, bytes: bytes });
    } catch (e) {
      // A thumbnail failing is not fatal; the row just stays blank.
    }
  }
}

function scheduleSelection() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(sendSelection, 120);
}

async function exportFrames(ids, scale) {
  cancelExport = false;
  lastExportIds = ids.slice();
  for (var i = 0; i < ids.length; i++) {
    if (cancelExport) {
      figma.ui.postMessage({ type: 'export-cancelled' });
      return;
    }
    var node = await figma.getNodeByIdAsync(ids[i]);
    if (!node || !('exportAsync' in node)) {
      throw new Error('Frame not found: was it deleted or moved?');
    }
    var bytes = await node.exportAsync({
      format: 'PNG',
      useAbsoluteBounds: true,
      constraint: { type: 'SCALE', value: scale }
    });
    figma.ui.postMessage({ type: 'export-frame', id: node.id, index: i, total: ids.length, bytes: bytes });
  }
  figma.ui.postMessage({ type: 'export-done' });
}

// Bounding box of the frames that were exported, to place the GIF next to them.
async function exportedBounds() {
  var minX = Infinity, minY = Infinity, maxX = -Infinity;
  for (var i = 0; i < lastExportIds.length; i++) {
    var node = await figma.getNodeByIdAsync(lastExportIds[i]);
    if (!node || !node.absoluteBoundingBox) continue;
    var b = node.absoluteBoundingBox;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
  }
  if (minX === Infinity) {
    var c = figma.viewport.center;
    return { x: c.x, y: c.y };
  }
  return { x: maxX + 80, y: minY };
}

async function insertGif(msg) {
  var image = figma.createImage(new Uint8Array(msg.bytes));
  var rect = figma.createRectangle();
  rect.name = msg.name;
  rect.resize(Math.max(1, msg.width), Math.max(1, msg.height));
  rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
  var pos = await exportedBounds();
  rect.x = pos.x;
  rect.y = pos.y;
  figma.currentPage.appendChild(rect);
  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);
  figma.notify('GIF inserted on the canvas');
}

figma.on('selectionchange', scheduleSelection);
figma.on('currentpagechange', scheduleSelection);

figma.ui.onmessage = async function (msg) {
  try {
    switch (msg.type) {
      case 'ready': {
        var saved = await figma.clientStorage.getAsync(SETTINGS_KEY);
        figma.ui.postMessage({ type: 'init', settings: saved || null });
        sendSelection();
        break;
      }
      case 'use-children':
        useChildren = !!msg.value;
        sendSelection();
        break;
      case 'save-settings':
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
        break;
      case 'export':
        await exportFrames(msg.ids, msg.scale);
        break;
      case 'cancel':
        cancelExport = true;
        break;
      case 'insert':
        await insertGif(msg);
        break;
      case 'notify':
        figma.notify(msg.message, { error: !!msg.error });
        break;
    }
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    if (msg.type === 'export') {
      figma.ui.postMessage({ type: 'export-error', message: message });
    } else {
      figma.notify(message, { error: true });
    }
  }
};
