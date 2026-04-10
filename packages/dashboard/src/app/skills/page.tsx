"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import SkillEditor from "@/components/SkillEditor";

type ActiveTab = "active" | string; // "active" or variation name like "v1"

export default function SkillsPage() {
  const { connected, skills, skillContent, sendCommand } =
    useWebSocket("ws://localhost:3100");

  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("active");

  // Request skill list on connect
  useEffect(() => {
    if (connected) {
      sendCommand({ type: "skills:list" });
    }
  }, [connected, sendCommand]);

  // Load skill content when selected; reset tab
  useEffect(() => {
    if (selectedSkill && connected) {
      sendCommand({ type: "skills:get", skillName: selectedSkill });
      setActiveTab("active");
    }
  }, [selectedSkill, connected, sendCommand]);

  // Derive the content to show based on selected tab
  const editorContent = useMemo(() => {
    if (!skillContent || skillContent.skillName !== selectedSkill) return null;
    if (activeTab === "active") return skillContent.content;
    const variation = skillContent.variations.find((v) => v.name === activeTab);
    return variation?.content ?? skillContent.content;
  }, [skillContent, selectedSkill, activeTab]);

  const handleSave = useCallback(
    (content: string) => {
      if (!selectedSkill) return;
      if (activeTab === "active") {
        sendCommand({ type: "skills:save", skillName: selectedSkill, content });
      } else {
        sendCommand({
          type: "skills:save_variation",
          skillName: selectedSkill,
          variationName: activeTab,
          content,
        });
      }
    },
    [selectedSkill, activeTab, sendCommand],
  );

  const handleNewVersion = useCallback(() => {
    if (!selectedSkill || !skillContent) return;
    const existingNums = skillContent.variations
      .map((v) => {
        const m = v.name.match(/^v(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => n > 0);
    const next = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
    const variationName = `v${next}`;
    // Save current active content as new variation
    sendCommand({
      type: "skills:save_variation",
      skillName: selectedSkill,
      variationName,
      content: skillContent.content,
    });
    setActiveTab(variationName);
  }, [selectedSkill, skillContent, sendCommand]);

  const handleSetActive = useCallback(() => {
    if (!selectedSkill || activeTab === "active") return;
    sendCommand({
      type: "skills:activate",
      skillName: selectedSkill,
      variationName: activeTab,
    });
    setActiveTab("active");
  }, [selectedSkill, activeTab, sendCommand]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href="/"
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              textDecoration: "none",
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
            }}
          >
            Back
          </a>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Skill Editor
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: connected ? "var(--success)" : "var(--error)",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: connected ? "var(--success)" : "var(--error)",
              }}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* Sidebar - skill list */}
        <aside
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            backgroundColor: "var(--bg-primary)",
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            Skills ({skills.length})
          </div>

          {skills.length === 0 && (
            <div
              style={{
                padding: 16,
                fontSize: 12,
                color: "var(--text-muted)",
                fontStyle: "italic",
              }}
            >
              {connected ? "No skills found" : "Connecting..."}
            </div>
          )}

          {skills.map((skill) => (
            <button
              key={skill.name}
              onClick={() => setSelectedSkill(skill.name)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                padding: "10px 16px",
                backgroundColor:
                  selectedSkill === skill.name
                    ? "var(--bg-tertiary)"
                    : "transparent",
                color:
                  selectedSkill === skill.name
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                border: "none",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: selectedSkill === skill.name ? 600 : 400,
                textAlign: "left",
                transition: "background-color 0.1s",
              }}
            >
              <span>{skill.name}</span>
              {skill.hasVariations && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    backgroundColor: "var(--bg-tertiary)",
                    padding: "1px 6px",
                    borderRadius: 3,
                  }}
                >
                  variants
                </span>
              )}
            </button>
          ))}
        </aside>

        {/* Editor area */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            padding: 16,
            overflow: "hidden",
          }}
        >
          {!selectedSkill ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
                color: "var(--text-muted)",
                fontSize: 14,
              }}
            >
              Select a skill from the sidebar to edit
            </div>
          ) : !skillContent || skillContent.skillName !== selectedSkill ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
                color: "var(--text-muted)",
                fontSize: 14,
              }}
            >
              Loading...
            </div>
          ) : (
            <>
              {/* Version tabs */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 2,
                  marginBottom: 0,
                }}
              >
                {/* Active tab */}
                <button
                  onClick={() => setActiveTab("active")}
                  style={{
                    fontSize: 11,
                    padding: "4px 10px",
                    borderRadius: "4px 4px 0 0",
                    border: "none",
                    borderBottom:
                      activeTab === "active"
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    backgroundColor:
                      activeTab === "active"
                        ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                        : "var(--bg-tertiary)",
                    color:
                      activeTab === "active"
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    cursor: "pointer",
                    fontWeight: activeTab === "active" ? 600 : 400,
                    transition: "background-color 0.1s",
                  }}
                >
                  Active
                </button>

                {/* Variation tabs */}
                {skillContent.variations.map((v) => (
                  <button
                    key={v.name}
                    onClick={() => setActiveTab(v.name)}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: "4px 4px 0 0",
                      border: "none",
                      borderBottom:
                        activeTab === v.name
                          ? "2px solid var(--accent)"
                          : "2px solid transparent",
                      backgroundColor:
                        activeTab === v.name
                          ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                          : "var(--bg-tertiary)",
                      color:
                        activeTab === v.name
                          ? "var(--accent)"
                          : "var(--text-muted)",
                      cursor: "pointer",
                      fontWeight: activeTab === v.name ? 600 : 400,
                      transition: "background-color 0.1s",
                    }}
                  >
                    {v.name}
                  </button>
                ))}

                {/* New Version button */}
                <button
                  onClick={handleNewVersion}
                  style={{
                    fontSize: 11,
                    padding: "4px 10px",
                    borderRadius: "4px 4px 0 0",
                    border: "1px dashed var(--border)",
                    borderBottom: "none",
                    backgroundColor: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    marginLeft: 4,
                    transition: "background-color 0.1s",
                  }}
                >
                  + New Version
                </button>
              </div>

              <SkillEditor
                skillName={selectedSkill}
                content={editorContent ?? ""}
                onSave={handleSave}
                activeTab={activeTab}
                onSetActive={activeTab !== "active" ? handleSetActive : undefined}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
