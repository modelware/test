import 'reflect-metadata';
import 'sprotty/css/sprotty.css';
import './diagram-client.css';

import { Container, injectable } from 'inversify';
import {
  ConsoleLogger,
  IActionDispatcher,
  LogLevel,
  ModelViewer,
  LocalModelSource,
  PolylineEdgeView,
  RectangularNodeView,
  SEdgeImpl,
  SGraphImpl,
  SGraphView,
  SLabelImpl,
  SLabelView,
  SNodeImpl,
  SChildElementImpl,
  TYPES,
  configureModelElement,
  loadDefaultModules,
  overrideViewerOptions
} from 'sprotty';
import type { IView, RenderingContext } from 'sprotty';
import type { SModelRoot } from 'sprotty-protocol';
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';

// ============================================================================
// Constants
// ============================================================================

const BASE_DIV_ID = 'sprotty';
const SVG_NS = 'http://www.w3.org/2000/svg';
const LABEL_GAP = 10; // px per step for label offsetting
const NODE_PADDING = 10;
const LINE_GAP = 6;
const PROPERTY_HEIGHT = 16;
const DEFAULT_FONT_SIZE = 13;

// Pan/Zoom constants
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

// VS Code webview API declaration for TypeScript (top-level)
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

// ============================================================================
// Marker Definitions
// ============================================================================

interface MarkerConfig {
  id: string;
  viewBox: string;
  refX: string;
  refY: string;
  markerWidth: string;
  markerHeight: string;
  paths: Array<{ class?: string; d: string }>;
}

const MARKER_CONFIGS: MarkerConfig[] = [
   // Open Arrow Markers (Relations)
  {
    id: 'oml-open-arrow',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12' }]
  },
  {
    id: 'oml-open-arrow-hover',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12' }]
  },
  {
    id: 'oml-open-arrow-selected',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12' }]
  },
  // Closed Triangle Markers (Specializations)
  {
    id: 'oml-closed-triangle',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12 Z' }]
  },
  {
    id: 'oml-closed-triangle-hover',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12 Z' }]
  },
  {
    id: 'oml-closed-triangle-selected',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [{ d: 'M0,0 L12,6 L0,12 Z' }]
  },
  // Equivalence Triangle Markers (Equivalence Axioms)
  {
    id: 'oml-equivalence-triangle',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [
      { d: 'M-8,0 L-8,12' },
      { d: 'M-5,0 L-5,12' },
      { d: 'M0,0 L12,6 L0,12 Z' }
    ]
  },
  {
    id: 'oml-equivalence-triangle-hover',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [
      { d: 'M-8,0 L-8,12' },
      { d: 'M-5,0 L-5,12' },
      { d: 'M0,0 L12,6 L0,12 Z' }
    ]
  },
  {
    id: 'oml-equivalence-triangle-selected',
    viewBox: '0 0 14 12',
    refX: '12',
    refY: '6',
    markerWidth: '16',
    markerHeight: '16',
    paths: [
      { d: 'M-8,0 L-8,12' },
      { d: 'M-5,0 L-5,12' },
      { d: 'M0,0 L12,6 L0,12 Z' }
    ]
  }
];

function createMarker(config: MarkerConfig): VNode {
  return h(`marker#${config.id}`, {
    ns: SVG_NS,
    attrs: {
      viewBox: config.viewBox,
      refX: config.refX,
      refY: config.refY,
      markerUnits: 'userSpaceOnUse',
      markerWidth: config.markerWidth,
      markerHeight: config.markerHeight,
      orient: 'auto',
      overflow: 'visible'
    }
  }, config.paths.map(p => h('path', {
    ns: SVG_NS,
    class: p.class?.split(' ').reduce((acc, cls) => ({ ...acc, [cls]: true }), {}),
    attrs: { d: p.d }
  })));
}

// ============================================================================
// Custom Views
// ============================================================================

class OmlGraphView extends SGraphView {
  override render(model: any, context: any) {
    const vnode: any = super.render(model, context);
    const defs = h('defs', { ns: SVG_NS }, MARKER_CONFIGS.map(createMarker));
    (vnode as any).children = (vnode as any).children ? [defs, ...(vnode as any).children] : [defs];
    return vnode;
  }
}

class OmlEdgeView extends PolylineEdgeView {
  protected override renderLine(edge: any, segments: any[], context: any, args?: any): VNode {
    const lineVNode = super.renderLine(edge, segments, context, args) as VNode;
    const kind = edge?.kind ?? edge?.data?.kind ?? 'relation';
    const hasMarker = edge?.hasMarker ?? true;
    
    const markerId = this.getMarkerId(kind, hasMarker);
    const attrsTarget = (lineVNode.data ?? (lineVNode.data = {})) as any;
    const attrs = (attrsTarget.attrs ?? (attrsTarget.attrs = {}));
    
    // Clean up all marker attributes
    delete attrs['marker-start'];
    delete attrs['marker-mid'];
    
    if (markerId) {
      attrs['marker-end'] = `url(#${markerId})`;
    } else {
      delete attrs['marker-end'];
    }
    
    return lineVNode;
  }

  private getMarkerId(kind: string, hasMarker: boolean): string | undefined {
    if (kind === 'specialization') return 'oml-closed-triangle';
    if (kind === 'equivalence' && hasMarker) return 'oml-equivalence-triangle';
    if (kind === 'relation' && hasMarker) return 'oml-open-arrow';
    return undefined;
  }

  override render(model: any, context: any) {
    const vnode = super.render(model, context) as VNode;
    this.applyLabelOffset(vnode, model);
    return vnode;
  }

  private applyLabelOffset(vnode: VNode, model: any) {
    try {
      const rawIndex = model?.labelIndex ?? model?.data?.labelIndex ?? 0;
      const idx = typeof rawIndex === 'number' ? Math.max(0, rawIndex) : 0;
      
      if (idx > 0) {
        const pairIndex = Math.ceil(idx / 2);
        const sign = (idx % 2 === 0) ? 1 : -1;
        const offsetY = pairIndex * LABEL_GAP * sign;

        const labelVNode = this.findLabelVNode(vnode);
        if (labelVNode) {
          const data = labelVNode.data ?? (labelVNode.data = {});
          const attrs = data.attrs ?? (data.attrs = {});
          const existing = typeof attrs.transform === 'string' ? attrs.transform : (data.props?.transform ?? '');
          const translate = `translate(0, ${offsetY})`;
          attrs.transform = existing ? `${translate} ${existing}` : translate;
        }
      }
    } catch (e) {
      // Swallow errors to avoid breaking rendering
    }
  }

  private findLabelVNode(vnode?: any): VNode | undefined {
    if (!vnode || !vnode.children) return undefined;
    
    for (const child of vnode.children) {
      const cls = child?.data?.class;
      if (cls && (cls['sprotty-label'] || cls['sprotty_label'])) return child as VNode;
      if (child.children && child.children.some((c: any) => c && c.sel === 'text')) return child as VNode;
      
      const found = this.findLabelVNode(child);
      if (found) return found;
    }
    
    return undefined;
  }
}

class OmlRectNodeView extends RectangularNodeView {
  override render(model: any, context: RenderingContext): VNode {
    const group = super.render(model, context) as VNode;
    
    try {
      const width = (model.size?.width ?? model.bounds?.width ?? 120) as number;
      const height = (model.size?.height ?? model.bounds?.height ?? 56) as number;
      
      this.renderTypes(group, model, width);
        this.pushLabelDown(group);
      const compartmentY = this.renderCompartmentLine(group, model, width, height);
      this.renderProperties(group, model, compartmentY);
    } catch {
      // Ignore drawing errors
    }
    
    return group;
  }

    private pushLabelDown(group: VNode) {
      // Set label y to 16px for top padding
      if (!group || !Array.isArray((group as any).children)) return;
      for (const child of (group as any).children) {
        if (child?.data?.class && (child.data.class['sprotty-label'] || child.data.class['sprotty_label'])) {
          const attrs = child.data.attrs ?? (child.data.attrs = {});
          attrs.y = 16;
        }
      }
    }

  private renderTypes(group: VNode, model: any, width: number) {
    const types: string[] = model.types ?? [];
    if (types.length === 0 || !Array.isArray((group as any).children)) return;

    const typesText = `«${types.join(', ')}»`;
    const typesVNode = h('text', {
      ns: SVG_NS,
      attrs: { x: width / 2, y: NODE_PADDING + 2, 'text-anchor': 'middle' },
      class: { 'oml-types-label': true }
    }, typesText);
    (group as any).children.push(typesVNode);
  }

  private renderCompartmentLine(group: VNode, model: any, width: number, height: number): number {
    const kindOffset = 16;
    const label = (model.children ?? []).find((c: any) => c.type === 'label');
    const labelY = (label?.bounds && Number.isFinite(label.bounds.y)) ? label.bounds.y as number : 0;
    const labelH = (label?.bounds && Number.isFinite(label.bounds.height) && label.bounds.height > 0)
      ? label.bounds.height as number
      : DEFAULT_FONT_SIZE;
    
    const compartmentY = Math.max(NODE_PADDING + kindOffset, Math.min(height - NODE_PADDING, labelY + labelH + LINE_GAP + kindOffset));

    const lineVNode = h('line', {
      ns: SVG_NS,
      class: { 'oml-compartment-line': true },
      attrs: {
        x1: NODE_PADDING,
        y1: compartmentY,
        x2: Math.max(NODE_PADDING, width - NODE_PADDING),
        y2: compartmentY
      }
    });

    if (Array.isArray((group as any).children)) {
      (group as any).children.push(lineVNode);
    }

    return compartmentY;
  }

  private renderProperties(group: VNode, model: any, compartmentY: number) {
    const properties: string[] = model.props ?? [];
    if (!Array.isArray((group as any).children)) return;

    properties.forEach((prop, idx) => {
      const py = compartmentY + LINE_GAP + idx * PROPERTY_HEIGHT;
      const textVNode = h('text', {
        ns: SVG_NS,
        attrs: { 
          x: NODE_PADDING + 4, 
          y: py
        },
        class: { 'oml-property-label': true }
      }, prop);
      (group as any).children.push(textVNode);
    });
  }
}

@injectable()
class EmptyView implements IView {
  render(element: any, context: RenderingContext): VNode {
    return h('g', { ns: SVG_NS, attrs: { visibility: 'hidden' } }, []);
  }
}

// ============================================================================
// Container Setup
// ============================================================================

function createOmlContainer(baseDiv: string): Container {
  const container = new Container();
  loadDefaultModules(container);
  
  overrideViewerOptions(container, {
    baseDiv,
    needsClientLayout: false,
    needsServerLayout: true
  });

  // Configure logging
  container.rebind(TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
  container.rebind(TYPES.LogLevel).toConstantValue(LogLevel.error);

  // Configure model elements
  configureModelElement(container, 'graph', SGraphImpl, OmlGraphView);
  configureModelElement(container, 'node:rect', SNodeImpl, OmlRectNodeView);
  configureModelElement(container, 'label', SLabelImpl, SLabelView);
  configureModelElement(container, 'edge', SEdgeImpl, OmlEdgeView);

  // Register empty views for routing handles
  const routingTypes = [
    'routing-point',
    'volatile-routing-point',
    'bezier-routing-point',
    'bezier-create-routing-point',
    'bezier-remove-routing-point'
  ];
  routingTypes.forEach(type => {
    configureModelElement(container, type, SChildElementImpl, EmptyView as any);
  });

  // Ensure LocalModelSource is bound
  if (!container.isBound(TYPES.ModelSource)) {
    container.bind(TYPES.ModelSource).to(LocalModelSource).inSingletonScope();
  }

  // Disable move functionality
  disableMoveListeners(container);

  return container;
}

function disableMoveListeners(container: Container) {
  if (!container.isBound(TYPES.MouseListener)) return;

  const allListeners = container.getAll(TYPES.MouseListener);
  const filtered = allListeners.filter((listener: any) => {
    const ctor = listener?.constructor?.name || '';
    return !ctor.includes('Move');
  });

  if (filtered.length > 0) {
    container.unbind(TYPES.MouseListener);
    filtered.forEach(listener => {
      container.bind(TYPES.MouseListener).toConstantValue(listener);
    });
  }
}

// ============================================================================
// Model Management
// ============================================================================

let currentDiagramModel: any = null;

function findElementById(model: any, id: string): any {
  if (!model) return null;
  if (model.id === id) return model;
  if (model.children) {
    for (const child of model.children) {
      const found = findElementById(child, id);
      if (found) return found;
    }
  }
  return null;
}

// ============================================================================
// Marker Management
// ============================================================================

class MarkerManager {
  private svg: SVGElement | null = null;

  constructor(private baseDiv: string) {}

  initialize() {
    const root = document.getElementById(this.baseDiv);
    if (!root) return;
    this.svg = root.querySelector('svg');
    if (!this.svg) return;

    this.setupObserver();
    this.setupHoverListeners(); // Add this
    this.updateMarkerReferences();
  }

  private setupHoverListeners() {
    if (!this.svg) return;

    // Use event delegation for better performance
    this.svg.addEventListener('mouseenter', (e) => {
      const target = e.target as Element;
      const edge = target.closest('g.sprotty-edge');
      if (edge) {
        edge.setAttribute('data-hover', 'true');
      }
    }, true);

    this.svg.addEventListener('mouseleave', (e) => {
      const target = e.target as Element;
      const edge = target.closest('g.sprotty-edge');
      if (edge) {
        edge.removeAttribute('data-hover');
      }
    }, true);
  }
  
  private setupObserver() {
    if (!this.svg) return;

    const observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
      this.updateMarkerReferences();
    });

    observer.observe(this.svg, {
      subtree: true,
      attributeFilter: ['class', 'data-hover'],
      attributeOldValue: true
    });
  }

  private handleMutations(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes') continue;
      
      const attr = mutation.attributeName;
      if (attr !== 'class' && attr !== 'data-hover') continue;

      const target = mutation.target as Element;
      const domId = this.extractDomId(target);
      if (!domId) continue;

      if (attr === 'class') {
        this.propagateSelection(target, domId);
      } else if (attr === 'data-hover') {
        this.propagateHover(target, domId);
      }
    }
  }

  private extractDomId(element: Element): string | undefined {
    let domId = element.getAttribute('id');
    if (!domId && element.parentElement) {
      domId = element.parentElement.getAttribute('id');
    }
    return domId || undefined;
  }

  private propagateSelection(target: Element, domId: string) {
    const isSelected = target.classList.contains('selected');
    
    // Handle vocabulary relation entities
    const relationBase = domId.replace(/-edge[12]$/, '');
    this.setSelected(document.getElementById(relationBase), isSelected);
    this.setSelected(document.getElementById(`${relationBase}-edge1`), isSelected);
    this.setSelected(document.getElementById(`${relationBase}-edge2`), isSelected);

    // Handle description relation instances
    const descRelationMatch = domId.match(/^(.+?)-(source|target)-edge\d+$/);
    if (descRelationMatch) {
      this.propagateToRelatedElements(descRelationMatch[1], isSelected, 'selected');
    }

    // Handle equivalence axioms
    const eqMatch = domId.match(/^(.+?)<->(\[?\d+\]?)(-edge\d+)?$/);
    if (eqMatch) {
      const eqPrefix = `${eqMatch[1]}<->${eqMatch[2]}`;
      this.propagateToElementsWithPrefix(eqPrefix, isSelected, 'selected');
    }
  }

  private propagateHover(target: Element, domId: string) {
    const isHover = target.hasAttribute('data-hover');
    const relationBase = domId.replace(/-edge[12]$/, '');
    
    this.setHover(document.getElementById(relationBase), isHover);
    this.setHover(document.getElementById(`${relationBase}-edge1`), isHover);
    this.setHover(document.getElementById(`${relationBase}-edge2`), isHover);
  }

  private propagateToRelatedElements(baseId: string, state: boolean, attribute: 'selected' | 'hover') {
    if (!this.svg) return;
    
    const allElements = this.svg.querySelectorAll('[id]');
    allElements.forEach((el) => {
      const elId = el.getAttribute('id') || '';
      if (elId === baseId || 
          elId.startsWith(`${baseId}-source-edge`) || 
          elId.startsWith(`${baseId}-target-edge`)) {
        if (attribute === 'selected') {
          this.setSelected(el, state);
        } else {
          this.setHover(el, state);
        }
      }
    });
  }

  private propagateToElementsWithPrefix(prefix: string, state: boolean, attribute: 'selected' | 'hover') {
    if (!this.svg) return;
    
    const allElements = this.svg.querySelectorAll('[id]');
    allElements.forEach((el) => {
      const elId = el.getAttribute('id') || '';
      if (elId.startsWith(prefix)) {
        if (attribute === 'selected') {
          this.setSelected(el, state);
        } else {
          this.setHover(el, state);
        }
      }
    });
  }

  private setSelected(el: Element | null, selected: boolean) {
    if (!el) return;
    const hasClass = el.classList.contains('selected');
    if (selected && !hasClass) el.classList.add('selected');
    else if (!selected && hasClass) el.classList.remove('selected');
  }

  private setHover(el: Element | null, hover: boolean) {
    if (!el) return;
    const hasAttr = el.hasAttribute('data-hover');
    if (hover && !hasAttr) el.setAttribute('data-hover', 'true');
    else if (!hover && hasAttr) el.removeAttribute('data-hover');
  }

  private updateMarkerReferences() {
    if (!this.svg) return;

    const edges = this.svg.querySelectorAll('g.sprotty-edge');
    edges.forEach((edge) => {
      const isSelected = edge.classList.contains('selected');
      const hasHoverAttr = edge.hasAttribute('data-hover');
      const lineElement = edge.querySelector('polyline, path, line') as SVGElement | null;

      if (!lineElement) return;

      const currentMarkerEnd = lineElement.getAttribute('marker-end');
      if (!currentMarkerEnd) return;

      const newMarkerEnd = this.determineMarkerEnd(currentMarkerEnd, isSelected, hasHoverAttr);
      if (newMarkerEnd && lineElement.getAttribute('marker-end') !== newMarkerEnd) {
        lineElement.setAttribute('marker-end', newMarkerEnd);
      }
    });
  }

  private determineMarkerEnd(currentMarker: string, isSelected: boolean, isHover: boolean): string | null {
    const markerType = this.getMarkerType(currentMarker);
    if (!markerType) return null;

    const suffix = isSelected ? '-selected' : (isHover ? '-hover' : '');
    return `url(#${markerType}${suffix})`;
  }

  private getMarkerType(markerEnd: string): string | null {
    if (markerEnd.includes('oml-open-arrow')) return 'oml-open-arrow';
    if (markerEnd.includes('oml-closed-triangle')) return 'oml-closed-triangle';
    if (markerEnd.includes('oml-equivalence-triangle')) return 'oml-equivalence-triangle';
    return null;
  }
}

// ============================================================================
// Pan & Zoom Controller
// ============================================================================

class PanZoomController {
  private isPanning = false;
  private startX = 0;
  private startY = 0;
  private panX = 0;
  private panY = 0;
  private scale = 1;

  private pinchActive = false;
  private pinchStartDist = 0;
  private pinchStartScale = 1;
  private pinchStartPanX = 0;
  private pinchStartPanY = 0;
  private pinchCenterX = 0;
  private pinchCenterY = 0;

  constructor(private root: HTMLElement, private target: HTMLElement) {
    this.initialize();
  }

  private initialize() {
    this.target.style.willChange = 'transform';
    this.root.style.cursor = 'grab';
    
    // Expose reset function
    (this.root as any).__resetView = () => this.reset();

    this.attachEventListeners();
  }

  private attachEventListeners() {
    this.root.addEventListener('mousedown', this.onMouseDown.bind(this), { capture: true });
    this.root.addEventListener('mousedown', this.preventNodeDrag.bind(this), { capture: true });
    window.addEventListener('mousemove', this.onMouseMove.bind(this), { capture: true });
    window.addEventListener('mouseup', this.onMouseUp.bind(this), { capture: true });
    this.root.addEventListener('wheel', this.onWheel.bind(this), { passive: false, capture: true });

    this.root.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false, capture: true });
    window.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false, capture: true });
    window.addEventListener('touchend', this.onTouchEnd.bind(this), { capture: true });
  }

  private onMouseDown(e: MouseEvent) {
    const el = e.target as Element;
    const hitInteractive = el.closest('g.sprotty-node, g.sprotty-edge') !== null;
    
    if (e.button === 1 || (e.button === 0 && !hitInteractive)) {
      this.isPanning = true;
      this.startX = e.clientX - this.panX;
      this.startY = e.clientY - this.panY;
      this.root.style.cursor = 'grabbing';
    }
  }

  private preventNodeDrag(e: MouseEvent) {
    if (e.button !== 0) return;
    
    const targetEl = e.target as Element;
    const onNode = targetEl.closest('g.sprotty-node') !== null;
    if (!onNode) return;

    const cancelDrag = (ev: MouseEvent) => ev.preventDefault();
    const up = () => {
      window.removeEventListener('mousemove', cancelDrag, true);
      window.removeEventListener('mouseup', up, true);
    };
    
    window.addEventListener('mousemove', cancelDrag, true);
    window.addEventListener('mouseup', up, true);
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isPanning) return;
    this.panX = e.clientX - this.startX;
    this.panY = e.clientY - this.startY;
    this.updateTransform();
    e.preventDefault();
  }

  private onMouseUp() {
    if (!this.isPanning) return;
    this.isPanning = false;
    this.root.style.cursor = 'grab';
  }

  private onWheel(e: WheelEvent) {
    const rect = this.root.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    this.zoomAt(this.scale * zoomFactor, cx, cy);
    e.preventDefault();
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      const t = e.touches.item(0)!;
      this.isPanning = true;
      this.startX = t.clientX - this.panX;
      this.startY = t.clientY - this.panY;
    } else if (e.touches.length === 2) {
      this.initializePinch(e);
    }
  }

  private initializePinch(e: TouchEvent) {
    this.pinchActive = true;
    const t0 = e.touches.item(0)!;
    const t1 = e.touches.item(1)!;
    this.pinchStartDist = this.distance(t0.clientX, t0.clientY, t1.clientX, t1.clientY);
    this.pinchStartScale = this.scale;
    this.pinchStartPanX = this.panX;
    this.pinchStartPanY = this.panY;
    
    const rect = this.root.getBoundingClientRect();
    this.pinchCenterX = (t0.clientX + t1.clientX) / 2 - rect.left;
    this.pinchCenterY = (t0.clientY + t1.clientY) / 2 - rect.top;
    this.isPanning = false;
  }

  private onTouchMove(e: TouchEvent) {
    if (this.pinchActive && e.touches.length === 2) {
      this.handlePinchMove(e);
      return;
    }
    
    if (this.isPanning && e.touches.length === 1) {
      const t = e.touches.item(0)!;
      this.panX = t.clientX - this.startX;
      this.panY = t.clientY - this.startY;
      this.updateTransform();
      e.preventDefault();
    }
  }

  private handlePinchMove(e: TouchEvent) {
    const t0 = e.touches.item(0)!;
    const t1 = e.touches.item(1)!;
    const d = this.distance(t0.clientX, t0.clientY, t1.clientX, t1.clientY);
    const newScale = this.clamp(this.pinchStartScale * (d / this.pinchStartDist), MIN_SCALE, MAX_SCALE);
    
    const s0 = this.scale;
    const s1 = newScale;
    this.panX = this.pinchStartPanX + (1 - s1 / s0) * (this.pinchCenterX - this.pinchStartPanX);
    this.panY = this.pinchStartPanY + (1 - s1 / s0) * (this.pinchCenterY - this.pinchStartPanY);
    this.scale = newScale;
    this.updateTransform();
    e.preventDefault();
  }

  private onTouchEnd(e: TouchEvent) {
    if (e.touches.length === 0) {
      this.isPanning = false;
      this.pinchActive = false;
    } else if (e.touches.length === 1) {
      this.pinchActive = false;
      const t = e.touches.item(0)!;
      this.startX = t.clientX - this.panX;
      this.startY = t.clientY - this.panY;
    }
  }

  private zoomAt(newScale: number, cx: number, cy: number) {
    const s0 = this.scale;
    const s1 = this.clamp(newScale, MIN_SCALE, MAX_SCALE);
    if (s1 === s0) return;
    
    this.panX = this.panX + (1 - s1 / s0) * (cx - this.panX);
    this.panY = this.panY + (1 - s1 / s0) * (cy - this.panY);
    this.scale = s1;
    this.updateTransform();
  }

  private updateTransform() {
    this.target.style.transformOrigin = '0 0';
    this.target.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
  }

  private reset() {
    this.panX = 0;
    this.panY = 0;
    this.scale = 1;
    this.updateTransform();
  }

  private distance(x1: number, y1: number, x2: number, y2: number): number {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

// ============================================================================
// Navigation Handler
// ============================================================================

class NavigationHandler {
  constructor(
    private baseDiv: string,
    private vscodeApi: any,
    private modelGetter: () => any
  ) {
    this.initialize();
  }

  private initialize() {
    window.addEventListener('dblclick', this.onDoubleClick.bind(this), { capture: true });
  }

  private onDoubleClick(e: MouseEvent) {
    const target = e.target as Element;
    const inDiagram = target.closest(`#${this.baseDiv}`) !== null;
    
    if (!inDiagram) return;

    const element = this.findClickedElement(target);
    
    if (element) {
      e.preventDefault();
      e.stopPropagation();
      
      const elementId = this.extractElementId(element);
      if (elementId) {
        const navigateId = this.resolveNavigationId(elementId);
        this.vscodeApi.postMessage({
          type: 'navigateToElement',
          elementId: navigateId
        });
        return;
      }
    }
    
    // No element clicked - reset view
    const root = document.getElementById(this.baseDiv);
    const resetView = (root as any)?.__resetView;
    if (typeof resetView === 'function') {
      resetView();
    }
  }

  private findClickedElement(target: Element): Element | null {
    const targetClasses = this.getClassNames(target);
    
    if (targetClasses.includes('sprotty-node')) return target;
    if (targetClasses.includes('sprotty-edge')) return target;
    
    return target.closest('[class*="sprotty-node"]') || 
           target.closest('[class*="sprotty-edge"]');
  }

  private getClassNames(element: Element): string {
    const className = element.className;
    if (className && typeof className === 'object' && 'baseVal' in className) {
      return (className as any).baseVal;
    }
    return className || '';
  }

  private extractElementId(element: Element): string | null {
    let elementId = element.getAttribute('id');
    if (!elementId && element.parentElement) {
      elementId = element.parentElement.getAttribute('id');
    }
    
    // Strip sprotty_ prefix
    if (elementId?.startsWith('sprotty_')) {
      elementId = elementId.substring('sprotty_'.length);
    }
    
    return elementId;
  }

  private resolveNavigationId(searchId: string): string {
    const model = this.modelGetter();
    if (!model) return searchId;

    // Relation entity edge
    if (searchId.endsWith('-edge1') || searchId.endsWith('-edge2')) {
      const qualifiedName = searchId.replace(/-edge[12]$/, '');
      const node = findElementById(model, qualifiedName);
      if (node?.type?.startsWith('node') && node.kind === 'relation-entity') {
        return qualifiedName;
      }
    }
    
    // Description relation instance edge
    const descRelMatch = searchId.match(/^(.+?)-(?:source|target)-edge\d+$/);
    if (descRelMatch) {
      const qualifiedName = descRelMatch[1];
      const node = findElementById(model, qualifiedName);
      if (node?.type?.startsWith('node') && node.kind === 'relation-instance') {
        return qualifiedName;
      }
    }
    
    // Equivalence axiom edge
    const eqEdgeMatch = searchId.match(/^\[(.+?)\]<->\[\d+\]-edge\d+$/);
    if (eqEdgeMatch) return eqEdgeMatch[1];
    
    // Equivalence axiom node
    const eqNodeMatch = searchId.match(/^\[(.+?)\]<->\[\d+\]$/);
    if (eqNodeMatch) return eqNodeMatch[1];
    
    // Specialization edge
    const specMatch = searchId.match(/^\[(.+?)\]->\[.+?\]$/);
    if (specMatch) return specMatch[1];
    
    // Direct equivalence edge
    const directEqMatch = searchId.match(/^\[(.+?)\]<->\[.+?\]$/);
    if (directEqMatch) return directEqMatch[1];
    
    return searchId;
  }
}

// ============================================================================
// Message Handler
// ============================================================================

class MessageHandler {
  constructor(
    private actionDispatcher: IActionDispatcher,
    private modelSource: LocalModelSource,
    private onModelUpdate: (model: any) => void
  ) {}

  handleMessage(message: any) {
    if (message?.type === 'theme') {
      this.handleTheme(message);
    } else if (message?.type === 'updateModel') {
      this.handleModelUpdate(message);
    }
  }

  private handleTheme(message: any) {
    try {
      const kind = message.kind === 'light' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-vscode-theme-kind', kind);
    } catch {}
  }

  private handleModelUpdate(message: any) {
    try {
      const root: SModelRoot = message.model as SModelRoot;
      this.onModelUpdate(root);

      try {
        this.actionDispatcher.dispatch({ 
          kind: 'updateModel', 
          newRoot: root, 
          animate: true 
        } as any);
      } catch (_) {
        if (typeof (this.modelSource as any).updateModel === 'function') {
          (this.modelSource as any).updateModel(root);
        } else {
          this.modelSource.setModel(root);
        }
      }
    } catch (err) {
      console.error('[OML Diagram] Error processing model:', err);
    }
  }
}

// ============================================================================
// Application Bootstrap
// ============================================================================

class DiagramApplication {
  private container: Container;
  private viewer: ModelViewer;
  private modelSource: LocalModelSource;
  private actionDispatcher: IActionDispatcher;
  private vscodeApi: any;
  private markerManager: MarkerManager;
  private messageHandler: MessageHandler;

  constructor() {
    this.container = createOmlContainer(BASE_DIV_ID);
    this.viewer = this.container.get<ModelViewer>(ModelViewer);
    this.modelSource = this.container.get<LocalModelSource>(TYPES.ModelSource);
    this.actionDispatcher = this.container.get<IActionDispatcher>(TYPES.IActionDispatcher);
    
    this.blockSetBoundsActions();
    this.initializeVSCodeAPI();
    this.markerManager = new MarkerManager(BASE_DIV_ID);
    this.messageHandler = new MessageHandler(
      this.actionDispatcher,
      this.modelSource,
      this.onModelUpdate.bind(this)
    );
  }

  start() {
    this.setupMessageListener();
    this.initializePanZoom();
    this.initializeNavigation();
    this.requestInitialModel();
  }

  private blockSetBoundsActions() {
    const originalDispatch = this.actionDispatcher.dispatch.bind(this.actionDispatcher);
    (this.actionDispatcher as any).dispatch = (action: any) => {
      if (action?.kind === 'setBounds') return;
      return originalDispatch(action);
    };
  }

  private initializeVSCodeAPI() {
    this.vscodeApi = acquireVsCodeApi();
  }

  private setupMessageListener() {
    window.addEventListener('message', (event: MessageEvent) => {
      this.messageHandler.handleMessage(event.data);
    });
  }

  private initializePanZoom() {
    const root = document.getElementById(BASE_DIV_ID);
    if (root) {
      new PanZoomController(root, root);
    }
  }

  private initializeNavigation() {
    new NavigationHandler(
      BASE_DIV_ID,
      this.vscodeApi,
      () => currentDiagramModel
    );
  }

  private onModelUpdate(model: any) {
    currentDiagramModel = model;
    setTimeout(() => this.markerManager.initialize(), 100);
  }

  private requestInitialModel() {
    this.vscodeApi.postMessage({ type: 'requestModel' });
  }
}

// ============================================================================
// Start Application
// ============================================================================

const app = new DiagramApplication();
app.start();