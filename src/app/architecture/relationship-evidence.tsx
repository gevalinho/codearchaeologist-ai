"use client";

import type { Edge, Node } from "../../lib/archaeology/scanner";
import { sourceReference } from "../../lib/architecture/graph";
import { describeRelationship } from "../../lib/architecture/relationship-presentation";

export default function RelationshipEvidence({
  edge,
  nodes,
  onSelectNode,
}: {
  edge: Edge;
  nodes: ReadonlyMap<string, Node>;
  onSelectNode: (node: Node) => void;
}) {
  const relationship = describeRelationship(edge, nodes);
  const sourceComponent = relationship.sourceComponent;
  const targetComponent = relationship.targetComponent;
  const supportingSource = relationship.source;

  return (
    <section
      className="arch-relations relationship-evidence"
      aria-label="Relationship evidence"
    >
      <h4>Relationship · {relationship.kind}</h4>
      <p className="relationship-certainty">
        {relationship.certainty} · {relationship.certaintyDescription}
      </p>
      <div className="relationship-direction">
        <span>{sourceComponent?.name ?? "Source component unavailable"}</span>
        <span aria-label="directed to">→</span>
        <span>{targetComponent?.name ?? "Target component unavailable"}</span>
      </div>
      <p className="relationship-method">
        Extraction method: {relationship.extractionMethod}
      </p>
      <div className="relationship-endpoints">
        {sourceComponent ? (
          <button type="button" onClick={() => onSelectNode(sourceComponent)}>
            Inspect source · {sourceReference(sourceComponent.source)}
          </button>
        ) : (
          <span>Source component evidence unavailable</span>
        )}
        {targetComponent ? (
          <button type="button" onClick={() => onSelectNode(targetComponent)}>
            Inspect target · {sourceReference(targetComponent.source)}
          </button>
        ) : (
          <span>Target component evidence unavailable</span>
        )}
      </div>
      <div className="arch-source">
        <small>SUPPORTING SOURCE REFERENCE</small>
        {supportingSource ? (
          <>
            <code>{sourceReference(supportingSource)}</code>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  sourceReference(supportingSource),
                )
              }
            >
              Copy reference
            </button>
          </>
        ) : (
          <p>Source reference unavailable in this graph artifact.</p>
        )}
      </div>
    </section>
  );
}
