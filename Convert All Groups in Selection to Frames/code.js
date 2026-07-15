function isGroupNode(node) {
  return node.type === "GROUP";
}

function canHaveChildren(node) {
  return !!node && "children" in node;
}

function cloneTransform(transform) {
  return [
    [...transform[0]],
    [...transform[1]],
  ];
}

function getAbsoluteTransform(node) {
  if (node && "absoluteTransform" in node) {
    return cloneTransform(node.absoluteTransform);
  }

  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}

/**
 * 2x3 Transform行列を掛け算する
 * FigmaのTransformは以下の形式
 * [
 *   [a, c, e],
 *   [b, d, f]
 * ]
 */
function multiplyTransform(a, b) {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
    ],
  ];
}

/**
 * 2x3 Transform行列の逆行列を作る
 */
function invertTransform(t) {
  const a = t[0][0];
  const c = t[0][1];
  const e = t[0][2];
  const b = t[1][0];
  const d = t[1][1];
  const f = t[1][2];

  const det = a * d - b * c;

  if (Math.abs(det) < 0.000001) {
    throw new Error("Transform matrix is not invertible.");
  }

  const invDet = 1 / det;

  const na = d * invDet;
  const nc = -c * invDet;
  const nb = -b * invDet;
  const nd = a * invDet;

  const ne = -(na * e + nc * f);
  const nf = -(nb * e + nd * f);

  return [
    [na, nc, ne],
    [nb, nd, nf],
  ];
}

function getRelativeTransformFromAbsolute(childAbsoluteTransform, parentAbsoluteTransform) {
  return multiplyTransform(invertTransform(parentAbsoluteTransform), childAbsoluteTransform);
}

function isAutoLayoutNode(node) {
  return !!node && "layoutMode" in node && node.layoutMode !== "NONE";
}

function setNodeAbsoluteTransform(node, absoluteTransform) {
  const parent = node.parent;

  if (!canHaveChildren(parent)) {
    return;
  }

  if (
    isAutoLayoutNode(parent) &&
    "layoutPositioning" in node &&
    node.layoutPositioning !== "ABSOLUTE"
  ) {
    return;
  }

  node.relativeTransform = getRelativeTransformFromAbsolute(
    absoluteTransform,
    getAbsoluteTransform(parent)
  );
}

function restoreChildrenAbsoluteTransforms(children, childAbsoluteTransforms, frame) {
  const frameAbsoluteTransform = getAbsoluteTransform(frame);

  for (const child of children) {
    const childAbsoluteTransform = childAbsoluteTransforms.get(child);

    if (childAbsoluteTransform) {
      child.relativeTransform = getRelativeTransformFromAbsolute(
        childAbsoluteTransform,
        frameAbsoluteTransform
      );
    }
  }
}

function copyLayoutProperties(fromNode, toNode) {
  const propertyNames = [
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
  ];

  for (const propertyName of propertyNames) {
    if (propertyName in fromNode && propertyName in toNode) {
      try {
        toNode[propertyName] = fromNode[propertyName];
      } catch (error) {
        console.warn(`Could not copy ${propertyName}.`, error);
      }
    }
  }
}

function collectGroups(node, groups, seen) {
  if (isGroupNode(node) && !seen.has(node.id)) {
    groups.push(node);
    seen.add(node.id);
  }

  if (!canHaveChildren(node)) {
    return;
  }

  for (const child of node.children) {
    collectGroups(child, groups, seen);
  }
}

function getNodeDepth(node) {
  let depth = 0;
  let parent = node.parent;

  while (parent) {
    depth += 1;
    parent = parent.parent;
  }

  return depth;
}

function createGroupSnapshot(group) {
  const children = [...group.children];
  const childAbsoluteTransforms = new Map();

  for (const child of children) {
    childAbsoluteTransforms.set(child, getAbsoluteTransform(child));
  }

  return {
    absoluteTransform: getAbsoluteTransform(group),
    childAbsoluteTransforms,
    height: group.height,
    locked: group.locked,
    opacity: group.opacity,
    visible: group.visible,
    width: group.width,
  };
}

function convertGroupToFrame(group, snapshot) {
  const parent = group.parent;

  if (!canHaveChildren(parent)) {
    return null;
  }

  const index = parent.children.indexOf(group);

  const parentIsAutoLayout = isAutoLayoutNode(parent);
  const children = [...group.children];

  const frame = figma.createFrame();

  frame.name = "Frame";
  frame.fills = [];
  frame.clipsContent = false;

  frame.resizeWithoutConstraints(
    Math.max(snapshot.width, 0.01),
    Math.max(snapshot.height, 0.01)
  );

  copyLayoutProperties(group, frame);

  parent.insertChild(index, frame);
  setNodeAbsoluteTransform(frame, snapshot.absoluteTransform);

  for (const child of children) {
    frame.appendChild(child);
  }

  if (!parentIsAutoLayout) {
    setNodeAbsoluteTransform(frame, snapshot.absoluteTransform);
  }

  restoreChildrenAbsoluteTransforms(children, snapshot.childAbsoluteTransforms, frame);

  group.remove();

  setNodeAbsoluteTransform(frame, snapshot.absoluteTransform);
  restoreChildrenAbsoluteTransforms(children, snapshot.childAbsoluteTransforms, frame);

  frame.opacity = snapshot.opacity;
  frame.visible = snapshot.visible;
  frame.locked = snapshot.locked;

  return frame;
}

const selection = figma.currentPage.selection;

if (selection.length === 0) {
  figma.notify("変換したい範囲を選択してください。");
  figma.closePlugin();
} else {
  const groups = [];
  const seen = new Set();

  for (const node of selection) {
    collectGroups(node, groups, seen);
  }

  const snapshots = new Map();

  for (const group of groups) {
    snapshots.set(group.id, createGroupSnapshot(group));
  }

  groups.sort((a, b) => getNodeDepth(a) - getNodeDepth(b));

  if (groups.length === 0) {
    figma.notify("選択範囲にGroupがありません。");
    figma.closePlugin();
  } else {
    const convertedFrames = [];
    let failedCount = 0;

    for (const group of groups) {
      try {
        const snapshot = snapshots.get(group.id);
        const frame = snapshot ? convertGroupToFrame(group, snapshot) : null;

        if (frame) {
          convertedFrames.push(frame);
        }
      } catch (error) {
        failedCount += 1;
        console.error(error);
      }
    }

    figma.currentPage.selection = convertedFrames.filter((frame) => !frame.removed);

    if (failedCount > 0) {
      figma.notify(
        `${convertedFrames.length}個のGroupをFrameに変換しました。${failedCount}個は変換できませんでした。`
      );
    } else {
      figma.notify(`${convertedFrames.length}個のGroupをFrameに変換しました。`);
    }

    figma.closePlugin();
  }
}
