/** Renders Mermaid source in the existing diagram owner; other Markdown keeps its native semantics. */
export function docsHtml() {
  return (tree) => {
    function text(node) { return node.type === 'text' ? node.value : (node.children ?? []).map(text).join('') }
    function visit(node) {
      if (node.type === 'element' && node.tagName === 'pre' && node.children?.[0]?.properties?.className?.includes('language-mermaid')) {
        node.properties = { ...node.properties, className: ['mermaid'] }
        node.children = [{ type: 'text', value: text(node) }]
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}
