import type { LangiumSharedServices } from 'langium/lsp';
import type { SModelRoot } from 'sprotty-protocol';
import { DefaultLayoutConfigurator } from 'sprotty-elk/lib/elk-layout.js';
import { ElkLayoutEngine } from 'sprotty-elk/lib/elk-layout.js';
import type { ElkFactory } from 'sprotty-elk/lib/elk-layout.js';
import { computeDiagramModel, type DiagramModel } from 'oml-language';
import * as ElkModule from 'elkjs/lib/elk.bundled.js';

// Create Elk factory for CJS environment
const elkFactory: ElkFactory = () => {
  const ElkCtor: any = (ElkModule as any).default ?? ElkModule;

  // In the VS Code web worker extension host, nested workers are disabled,
  // so use ELK's FakeWorker to run layouts on the same thread.
  // The elkjs worker module only exposes its FakeWorker when it thinks it is
  // running in a CommonJS environment. We temporarily fake `document` to force
  // that branch so we can grab the constructor.
  const loadElkWorkerCtor = (): any => {
    const hadDocument = typeof (globalThis as any).document !== 'undefined';
    const previousDocument = (globalThis as any).document;
    try {
      (globalThis as any).document = {};
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('elkjs/lib/elk-worker.js');
      return mod.Worker ?? mod.default?.Worker ?? mod.default ?? mod;
    } finally {
      if (hadDocument) {
        (globalThis as any).document = previousDocument;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).document;
      }
    }
  };

  const ElkWorkerCtor: any = loadElkWorkerCtor();

  const workerFactory = (url: string) => new ElkWorkerCtor(url) as unknown;

  return new ElkCtor({ algorithms: ['layered'], workerFactory });
};

/** Custom layout config */
class OmlLayoutConfigurator extends DefaultLayoutConfigurator {
  protected override graphOptions(): Record<string, string> | undefined {
    return {
      // Required: consistent UML-style direction
      'org.eclipse.elk.algorithm': 'org.eclipse.elk.layered',
      'org.eclipse.elk.direction': 'UP',

      // Layering + crossing minimization
      'org.eclipse.elk.layered.layering.strategy': 'LONGEST_PATH',
      'org.eclipse.elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'org.eclipse.elk.layered.considerModelOrder.strategy': 'PREFER_NODES',

      // Node placement (very stable and readable)
      'org.eclipse.elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'org.eclipse.elk.layered.nodePlacement.bk.fixedAlignment': 'CENTER',

      // Routing
      'org.eclipse.elk.edgeRouting': 'POLYLINE',
      'org.eclipse.elk.layered.edgeRouting': 'POLYLINE',

      // Prevents merged multi-edges
      'org.eclipse.elk.layered.mergeEdges': 'false',
      'org.eclipse.elk.layered.crossingMinimization.separateEdgeGroups': 'true',

      // Spacing
      'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'org.eclipse.elk.spacing.nodeNode': '28',
      'org.eclipse.elk.spacing.edgeNode': '24',
      'org.eclipse.elk.spacing.edgeEdge': '18',
      'org.eclipse.elk.spacing.portPort': '12',

      // Self-loops
      'org.eclipse.elk.insideSelfLoops.activate': 'true',
      'org.eclipse.elk.spacing.nodeSelfLoop': '48',
      'org.eclipse.elk.layered.edgeRouting.selfLoopDistribution': 'EQUALLY',
      'org.eclipse.elk.layered.edgeRouting.selfLoopOrdering': 'STACKED',
      'org.eclipse.elk.layered.edgeRouting.selfLoopPlacement': 'NORTH_SEQUENCE'
    };
  }

  protected override labelOptions(): Record<string, string> | undefined {
    return {
      'org.eclipse.elk.nodeLabels.placement': 'INSIDE, H_CENTER, V_TOP'
    };
  }
}

const layoutEngine = new ElkLayoutEngine(elkFactory, undefined as any, new OmlLayoutConfigurator());

/* Convert OML DiagramModel to Sprotty model */
function diagramToSprotty(model: DiagramModel): SModelRoot {
  const nodes: any[] = [];
  const edges: any[] = [];
  const nodeWidth = 120;
  const baseNodeHeight = 56;

  // Create nodes
  model.nodes.forEach((n) => {
    if (n.kind !== 'relation') {
      const avgCharPx = 7.5;
      const paddingX = 24;
      const labelText = n.label ?? n.id;
      const types = n.types ?? [];
      const properties = n.properties ?? [];
      
      // For width calculation, consider types, label, and properties
      const typesText = types.length > 0 ? `«${types.join(', ')}»` : '';
      const allTexts = [typesText, labelText, ...properties].filter(t => t.length > 0);
      const maxTextLength = Math.max(...allTexts.map(t => t.length));
      const width = Math.max(nodeWidth, Math.min(600, paddingX + avgCharPx * maxTextLength));

      const propertyLineHeight = 16;
      const typesLineHeight = types.length > 0 ? 16 : 0;
      const headerHeight = 32;
      const propsHeight = properties.length * propertyLineHeight;
      const height = Math.max(baseNodeHeight, typesLineHeight + headerHeight + propsHeight + 8);

      // Store source location in cssClasses as a workaround - ELK preserves this
      const cssClasses = [];
      if (n.startLine !== undefined) {
        cssClasses.push(`src-${n.startLine}-${n.startColumn}-${n.endLine}-${n.endColumn}`);
      }
      
      nodes.push({
        id: n.id,
        type: 'node:rect',
        kind: n.kind,
        size: { width, height },
        types: types,
        props: properties,
        cssClasses: cssClasses.length > 0 ? cssClasses : undefined,
        layoutOptions: { 'org.eclipse.elk.portConstraints': 'FREE' },
        children: [
          {
            id: `${n.id}_label`,
            type: 'label',
            text: labelText,
            layoutOptions: {
              'org.eclipse.elk.labelSize': `${width - 20},20`,
              'org.eclipse.elk.nodeLabels.offsetY': types.length > 0 ? '28' : '12'
            }
          }
        ]
      });
    }
  });

  // Unique ID tracking
  const usedIds = new Set<string>(nodes.map(n => n.id));
  function makeUniqueId(base: string) {
    let id = base;
    let i = 1;
    while (usedIds.has(id)) id = `${base}:${i++}`;
    usedIds.add(id);
    return id;
  }

  const selfLoopAssigned: Record<string, number> = {};

  // Create edges
  model.edges.forEach((e) => {
    const isSpec = e.kind === 'specialization' || e.kind === 'equivalence';
    const isSelfLoop = e.source === e.target;

    // Base specialization or association settings
    const baseLayoutOptions = isSpec
      ? {
          'org.eclipse.elk.edge.type': 'GENERALIZATION',
          'org.eclipse.elk.edge.source.side': 'NORTH',
          'org.eclipse.elk.edge.target.side': 'SOUTH'
        }
      : {
          'org.eclipse.elk.edge.type': 'ASSOCIATION',
          'org.eclipse.elk.edge.routing': 'POLYLINE'
        };

    // Self-loop handling
    let selfLoopOptions = {};
    if (isSelfLoop) {
      const count = selfLoopAssigned[e.source] ?? 0;
      selfLoopAssigned[e.source] = count + 1;

      selfLoopOptions = {
        'org.eclipse.elk.layered.edgeRouting.selfLoopDistribution': 'EQUALLY',
        'org.eclipse.elk.layered.edgeRouting.selfLoopPlacement': 'NORTH_SEQUENCE',
        'org.eclipse.elk.spacing.nodeSelfLoop': '56'
      };
    }

    const id = makeUniqueId(e.id ? String(e.id) : `${e.source}->${e.target}`);

    // Store source location in cssClasses as a workaround
    const edgeCssClasses = [];
    if (e.startLine !== undefined) {
      edgeCssClasses.push(`src-${e.startLine}-${e.startColumn}-${e.endLine}-${e.endColumn}`);
    }

    // Calculate label size based on text length to prevent overlap
    let labelWidth = 60;
    let labelHeight = 14;
    if (e.label) {
      const avgCharWidth = 7.5;
      const padding = 8;
      labelWidth = Math.max(60, Math.min(300, e.label.length * avgCharWidth + padding));
      labelHeight = 14;
    }

    edges.push({
      id,
      type: 'edge',
      kind: e.kind,
      hasMarker: e.hasMarker,
      sourceId: e.source,
      targetId: e.target,
      labelIndex: isSelfLoop ? selfLoopAssigned[e.source] - 1 : 0,
      cssClasses: edgeCssClasses.length > 0 ? edgeCssClasses : undefined,
      layoutOptions: {
        'org.eclipse.elk.edgeLabels.placement': 'CENTER',
        ...baseLayoutOptions,
        ...selfLoopOptions,
      },
      children: e.label
        ? [
            {
              id: `${id}_label`,
              type: 'label',
              text: e.label,
              layoutOptions: {
                'org.eclipse.elk.labelSize': `${labelWidth},${labelHeight}`,

                // Put label in center of edge to avoid overlap
                'org.eclipse.elk.edgeLabels.placement': 'CENTER',

                'org.eclipse.elk.edgeLabels.inline': 'false',
                'org.eclipse.elk.edgeLabels.side': 'ABOVE'
              }
            }
          ]
        : []
    });
  });

  // Debug: Print all node and edge IDs, and check for missing references
  const nodeIds = new Set(nodes.map(n => n.id));
  const edgeRefs = edges.map(e => ({ source: e.sourceId, target: e.targetId, id: e.id }));

  // Check for missing source/target nodes
  edgeRefs.forEach(ref => {
    if (!nodeIds.has(ref.source)) {
      console.warn(`Missing source node for edge: ${ref.id} (source: ${ref.source})`);
    }
    if (!nodeIds.has(ref.target)) {
      console.warn(`Missing target node for edge: ${ref.id} (target: ${ref.target})`);
    }
  });

  return {
    id: 'root',
    type: 'graph',
    layoutOptions: {
      'org.eclipse.elk.algorithm': 'org.eclipse.elk.layered',
      'org.eclipse.elk.direction': 'DOWN'
    },
    children: [...nodes, ...edges]
  } as unknown as SModelRoot;
}

/** Compute + layout diagram */
export async function computeLaidOutSModelForUri(
  shared: LangiumSharedServices,
  uri: string
): Promise<SModelRoot> {
  const diagram = await computeDiagramModel(shared, uri);
  const root = diagramToSprotty(diagram);
  try {
    // Run ELK layout
    const laidOut = await layoutEngine.layout(root as any);

    // ==============================
    // ADJUST EDGE LABEL POSITIONING
    // ==============================
    // For edges with labels, ELK CENTER placement works well for most cases.
    // Only adjust position for edges without explicit CENTER placement if needed.
    // The CENTER placement avoids overlap better than forcing to arrowhead.
    for (const child of laidOut.children ?? []) {
      if (child.type === 'edge' && Array.isArray(child.children)) {
        // find the label element
        const label = child.children.find(c => c.type === 'label');
        if (!label) continue;

        // Check if label has CENTER placement (from layoutOptions)
        const layoutOptions = (child as any).layoutOptions ?? {};
        const placement = layoutOptions['org.eclipse.elk.edgeLabels.placement'];
        
        // Only adjust for TAIL placement (vocabulary edges), leave CENTER alone (description edges)
        if (placement !== 'TAIL') continue;

        const pts = (child as any).routingPoints ?? (child as any).points ?? (child as any).bendPoints ?? [];
        if (pts.length < 2) continue;

        // last segment of the polyline
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];

        // normalize direction vector
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) continue;

        const ux = dx / dist;
        const uy = dy / dist;

        // place label 12px BEFORE the arrowhead
        (label as any).position = {
          x: last.x - ux * 12,
          y: last.y - uy * 12
        };
      }
    }

    return laidOut as unknown as SModelRoot;
  } catch (err) {
    console.error('[diagram-layout] ELK layout failed — fallback:', err);
    return root as SModelRoot;
  }
}
