/**
 * A small immutable AVL map for normalized session entities.
 *
 * Object-spreading a flat item record made every streaming delta proportional
 * to all retained items. This map copies only the logarithmic search path and
 * keeps deterministic string ordering without trusting foreign IDs as object
 * property names.
 */
interface EntityNode<Value> {
  readonly height: number;
  readonly key: string;
  readonly left: EntityNode<Value> | null;
  readonly right: EntityNode<Value> | null;
  readonly value: Value;
}

export class SessionEntityMap<Value> {
  readonly #root: EntityNode<Value> | null;
  readonly size: number;

  private constructor(root: EntityNode<Value> | null, size: number) {
    this.#root = root;
    this.size = size;
    Object.freeze(this);
  }

  get(key: string): Value | undefined {
    let node = this.#root;
    while (node !== null) {
      if (key === node.key) return node.value;
      node = key < node.key ? node.left : node.right;
    }
    return undefined;
  }

  *entries(): IterableIterator<readonly [string, Value]> {
    const stack: EntityNode<Value>[] = [];
    let node = this.#root;
    while (node !== null || stack.length > 0) {
      while (node !== null) {
        stack.push(node);
        node = node.left;
      }
      const current = stack.pop();
      if (current === undefined) return;
      yield Object.freeze([current.key, current.value] as const);
      node = current.right;
    }
  }

  *values(): IterableIterator<Value> {
    for (const [, value] of this.entries()) yield value;
  }

  static empty<Value>(): SessionEntityMap<Value> {
    return new SessionEntityMap<Value>(null, 0);
  }

  with(key: string, value: Value): SessionEntityMap<Value> {
    const result = setNode(this.#root, key, value);
    return result.node === this.#root
      ? this
      : new SessionEntityMap(result.node, this.size + (result.added ? 1 : 0));
  }

  without(key: string): SessionEntityMap<Value> {
    const result = deleteNode(this.#root, key);
    return result.removed
      ? new SessionEntityMap(result.node, this.size - 1)
      : this;
  }
}

export function createSessionEntityMap<Value>(): SessionEntityMap<Value> {
  return SessionEntityMap.empty<Value>();
}

export function setSessionEntity<Value>(
  map: SessionEntityMap<Value>,
  key: string,
  value: Value,
): SessionEntityMap<Value> {
  return map.with(key, value);
}

export function deleteSessionEntity<Value>(
  map: SessionEntityMap<Value>,
  key: string,
): SessionEntityMap<Value> {
  return map.without(key);
}

function nodeHeight<Value>(node: EntityNode<Value> | null): number {
  return node?.height ?? 0;
}

function createNode<Value>(
  key: string,
  value: Value,
  left: EntityNode<Value> | null,
  right: EntityNode<Value> | null,
): EntityNode<Value> {
  return Object.freeze({
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
    key,
    left,
    right,
    value,
  });
}

function balanceNode<Value>(node: EntityNode<Value>): EntityNode<Value> {
  const balance = nodeHeight(node.left) - nodeHeight(node.right);
  if (balance > 1) {
    const left = node.left;
    if (left === null) return node;
    if (nodeHeight(left.left) < nodeHeight(left.right)) {
      const rotatedLeft = rotateLeft(left);
      return rotateRight(createNode(
        node.key,
        node.value,
        rotatedLeft,
        node.right,
      ));
    }
    return rotateRight(node);
  }
  if (balance < -1) {
    const right = node.right;
    if (right === null) return node;
    if (nodeHeight(right.right) < nodeHeight(right.left)) {
      const rotatedRight = rotateRight(right);
      return rotateLeft(createNode(
        node.key,
        node.value,
        node.left,
        rotatedRight,
      ));
    }
    return rotateLeft(node);
  }
  return node;
}

function rotateLeft<Value>(node: EntityNode<Value>): EntityNode<Value> {
  const pivot = node.right;
  if (pivot === null) return node;
  const left = createNode(node.key, node.value, node.left, pivot.left);
  return createNode(pivot.key, pivot.value, left, pivot.right);
}

function rotateRight<Value>(node: EntityNode<Value>): EntityNode<Value> {
  const pivot = node.left;
  if (pivot === null) return node;
  const right = createNode(node.key, node.value, pivot.right, node.right);
  return createNode(pivot.key, pivot.value, pivot.left, right);
}

function setNode<Value>(
  node: EntityNode<Value> | null,
  key: string,
  value: Value,
): Readonly<{ added: boolean; node: EntityNode<Value> }> {
  if (node === null) return { added: true, node: createNode(key, value, null, null) };
  if (key === node.key) {
    return node.value === value
      ? { added: false, node }
      : { added: false, node: createNode(key, value, node.left, node.right) };
  }
  if (key < node.key) {
    const result = setNode(node.left, key, value);
    return {
      added: result.added,
      node: result.node === node.left
        ? node
        : balanceNode(createNode(node.key, node.value, result.node, node.right)),
    };
  }
  const result = setNode(node.right, key, value);
  return {
    added: result.added,
    node: result.node === node.right
      ? node
      : balanceNode(createNode(node.key, node.value, node.left, result.node)),
  };
}

function deleteNode<Value>(
  node: EntityNode<Value> | null,
  key: string,
): Readonly<{ node: EntityNode<Value> | null; removed: boolean }> {
  if (node === null) return { node, removed: false };
  if (key < node.key) {
    const result = deleteNode(node.left, key);
    return result.removed
      ? {
          node: balanceNode(createNode(node.key, node.value, result.node, node.right)),
          removed: true,
        }
      : { node, removed: false };
  }
  if (key > node.key) {
    const result = deleteNode(node.right, key);
    return result.removed
      ? {
          node: balanceNode(createNode(node.key, node.value, node.left, result.node)),
          removed: true,
        }
      : { node, removed: false };
  }
  if (node.left === null) return { node: node.right, removed: true };
  if (node.right === null) return { node: node.left, removed: true };
  const successor = minimumNode(node.right);
  const right = deleteNode(node.right, successor.key).node;
  return {
    node: balanceNode(createNode(successor.key, successor.value, node.left, right)),
    removed: true,
  };
}

function minimumNode<Value>(node: EntityNode<Value>): EntityNode<Value> {
  let current = node;
  while (current.left !== null) current = current.left;
  return current;
}
