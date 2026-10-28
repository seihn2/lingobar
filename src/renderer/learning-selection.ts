import { validPhrase, type Phrase } from '../shared/learning'
const excluded = (node: Node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).matches('rt,rp,button,[aria-hidden="true"],[data-selection-exclude]')
const length = (node: Node): number => excluded(node) ? 0 : node.nodeType === Node.TEXT_NODE ? node.textContent!.length : [...node.childNodes].reduce((total, child) => total + length(child), 0)
function offsetIn(root: Node, node: Node, offset: number): number | null {
  if (!root.contains(node) || !Number.isInteger(offset) || offset < 0) return null
  for (let ancestor: Node | null = node; ancestor && ancestor !== root; ancestor = ancestor.parentNode) if (excluded(ancestor)) return null
  if (node.nodeType === Node.TEXT_NODE ? offset > node.textContent!.length : offset > node.childNodes.length) return null
  let total = node.nodeType === Node.TEXT_NODE ? offset : [...node.childNodes].slice(0, offset).reduce((sum, child) => sum + length(child), 0)
  for (let current = node; current !== root; current = current.parentNode!) {
    if (!current.parentNode) return null
    for (const sibling of current.parentNode.childNodes) { if (sibling === current) break; total += length(sibling) }
  }
  return total
}
export function selectedPhrase(root: HTMLElement, source: string, selection: Selection | null): Phrase | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const plain = (node: Node): string => excluded(node) ? '' : node.nodeType === Node.TEXT_NODE ? node.textContent! : [...node.childNodes].map(plain).join('')
  if (plain(root) !== source) return null
  const range = selection.getRangeAt(0)
  const start = offsetIn(root, range.startContainer, range.startOffset)
  const end = offsetIn(root, range.endContainer, range.endOffset)
  if (start === null || end === null) return null
  const phrase = { start, end, exact: source.slice(start, end) }
  return validPhrase(source, phrase) ? phrase : null
}
