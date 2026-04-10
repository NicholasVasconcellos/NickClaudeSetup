"use client";

import React, { useState } from "react";

export interface TreeNode {
  path: string;
  name: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

interface FileTreeProps {
  tree: TreeNode[];
  changedFiles?: string[];
}

function FileTreeNode({
  node,
  depth,
  expanded,
  onToggle,
  changedFiles,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  changedFiles?: Set<string>;
}) {
  const isDir = node.type === "directory";
  const isExpanded = expanded.has(node.path);
  const isChanged = changedFiles?.has(node.path) ?? false;

  return (
    <div>
      <div
        onClick={isDir ? () => onToggle(node.path) : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: depth * 16,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 12,
          fontFamily: "monospace",
          lineHeight: "18px",
          cursor: isDir ? "pointer" : "default",
          color: isDir ? "var(--text-secondary)" : "var(--text-muted)",
          borderLeft: isChanged ? "2px solid var(--accent, #58a6ff)" : "2px solid transparent",
          userSelect: "none",
        }}
      >
        <span style={{ width: 12, flexShrink: 0, textAlign: "center", fontSize: 10 }}>
          {isDir ? (isExpanded ? "\u25BE" : "\u25B8") : "\u00B7"}
        </span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name}
        </span>
      </div>
      {isDir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              changedFiles={changedFiles}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ tree, changedFiles }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const changedSet = changedFiles ? new Set(changedFiles) : undefined;

  const onToggle = (nodePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodePath)) {
        next.delete(nodePath);
      } else {
        next.add(nodePath);
      }
      return next;
    });
  };

  if (tree.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
        No files loaded
      </div>
    );
  }

  return (
    <div style={{ overflowY: "auto", maxHeight: 300 }}>
      {tree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={onToggle}
          changedFiles={changedSet}
        />
      ))}
    </div>
  );
}
