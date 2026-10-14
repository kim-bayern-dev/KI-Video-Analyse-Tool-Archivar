import { createRef, t, type Ref, type Props, $ } from "defuss";
import type { SummaryResult, SummaryQualityAttributes } from "../../../db/db.js";
import { renderMarkdown, renderInlineMarkdown } from "../../lib/markdown.js";

/**
 * Imperative handle exposed via ref.state; the dashboard calls
 * loadV3Summary when a file with a v3 summary is selected, and clear() when
 * the selection goes away (screens/dashboard.tsx).
 */
export interface SummaryViewRef {
  loadV3Summary: (summary: { title?: string; keywords?: string[]; short_description?: string; long_summary?: string } | null) => void;
  clear: () => void;
}

export interface SummaryViewProps extends Props {
  ref?: Ref<HTMLDivElement, SummaryViewRef>;
}

/**
 * Renders the analysis summary of the selected file. Every section is
 * conditional, which is why loadV3Summary can pass a partial v3 projection
 * and still reuse the same SummaryResult rendering path.
 *
 * The long_summary markdown is injected via innerHTML AFTER the VDOM commit
 * (requestAnimationFrame) because defuss does not attach refs inside
 * $().update() content — see the note at markdownRef.
 */
export const SummaryView = ({ ref = createRef<HTMLDivElement, SummaryViewRef>() }: SummaryViewProps) => {
  const contentRef = createRef<HTMLDivElement>();
  // REFACTOR(kiss): markdownRef never resolves — the markdown container is
  // injected via $(contentRef).update(), which does not attach nested refs
  // (hence the querySelector workaround in loadV3Summary). The ref is dead
  // weight; drop it and keep the querySelector.
  const markdownRef = createRef<HTMLDivElement>();

  const renderEmpty = () => (
    <div className="p-6 text-center text-muted-foreground italic">
      {t("dashboard.summary_empty")}
    </div>
  );

  const renderQualityAttribute = (label: string, value?: string) => {
    if (!value) return null;
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground w-32">{label}</span>
        <span className="text-sm">{value}</span>
      </div>
    );
  };

  // REFACTOR(complexity): the same conditional "h4 heading + pre-wrap
  // paragraph" section is hand-copied 9 times below (~100 lines) — a small
  // descriptor array or a renderSection(label, text) helper (mirroring
  // renderQualityAttribute) would collapse this.
  const renderSummary = (summary: SummaryResult) => {
    const qa = summary.qualityAttributes ?? {} as SummaryQualityAttributes;

    return (
      <div className="flex flex-col gap-5 p-4">
        {/* Title */}
        {summary.title && (
          <div>
            <h3 className="text-lg font-bold" dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(summary.title) }} />
          </div>
        )}

        {/* Abstract */}
        {summary.abstract && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_abstract")}</h4>
            <div className="text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.abstract) }} />
          </div>
        )}

        {/* Keywords */}
        {summary.keywords && summary.keywords.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-2">{t("dashboard.summary_keywords")}</h4>
            <div className="flex flex-wrap gap-1.5">
              {summary.keywords.map((kw) => (
                <span className="text-xs px-2 py-1 bg-primary/10 text-primary rounded-full font-medium">{kw}</span>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {summary.tags && summary.tags.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-2">{t("dashboard.summary_tags")}</h4>
            <div className="flex flex-wrap gap-1.5">
              {summary.tags.map((tag) => (
                <span className="text-xs px-2 py-1 bg-accent text-accent-foreground rounded">{tag}</span>
              ))}
            </div>
          </div>
        )}

        {/* Categorization */}
        {summary.categorization && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_categorization")}</h4>
            <p className="text-sm">{summary.categorization}</p>
          </div>
        )}

        {/* Overall Intention */}
        {summary.overallIntention && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_overall_intention")}</h4>
            <div className="text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.overallIntention) }} />
          </div>
        )}

        {/* Narrative Arc */}
        {summary.narrativeArc && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_narrative_arc")}</h4>
            <div className="text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.narrativeArc) }} />
          </div>
        )}

        {/* Perception Arc */}
        {summary.perceptionArc && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_perception_arc")}</h4>
            <div className="text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.perceptionArc) }} />
          </div>
        )}

        {/* V3 Summary Fields - short_description */}
        {/* REFACTOR(consistency): defuss t() returns the KEY when a translation
            is missing, so the `|| "Short Description"` / `|| "Long Summary"`
            fallbacks never fire — and dashboard.summary_short_description is
            absent from both i18n/*.json, so users currently see the raw key.
            Every other label here relies on existing keys; add the missing
            i18n entry instead of inline fallbacks. */}
        {summary.short_description && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_short_description") || "Short Description"}</h4>
            <div className="text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.short_description) }} />
          </div>
        )}

        {/* V3 Summary Fields - long_summary (rendered as markdown) */}
        {summary.long_summary && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t("dashboard.summary_long_summary") || "Long Summary"}</h4>
            <div ref={markdownRef} className="text-sm markdown-content" />
          </div>
        )}

        {/* Quality Attributes */}
        {qa && Object.values(qa).some(Boolean) && (
          <div>
            <h4 className="text-sm font-semibold text-muted-foreground mb-2">{t("dashboard.summary_quality")}</h4>
            <div className="flex flex-col gap-1.5 border border-border rounded p-3">
              {renderQualityAttribute(t("dashboard.summary_qa_quality"), qa.quality)}
              {renderQualityAttribute(t("dashboard.summary_qa_age"), qa.age)}
              {renderQualityAttribute(t("dashboard.summary_qa_colorization"), qa.colorization)}
              {renderQualityAttribute(t("dashboard.summary_qa_geo"), qa.geoRegion)}
              {renderQualityAttribute(t("dashboard.summary_qa_language"), qa.languageSpoken)}
              {renderQualityAttribute(t("dashboard.summary_qa_material_age"), qa.materialAge)}
            </div>
          </div>
        )}
      </div>
    );
  };

  ref.state = {
    ...ref.state,
    loadV3Summary: (summary) => {
      if (!summary || (!summary.title && !summary.short_description && !summary.long_summary && (!summary.keywords?.length))) {
        $(contentRef).update(renderEmpty());
        return;
      }
      // loadV3Summary passes a partial v3 projection where renderSummary
      // expects a full SummaryResult — safe because every section renders
      // conditionally.
      const ls = (summary as any).long_summary;
      console.log("[summary-view] loadV3Summary: long_summary length:", ls ? ls.length : "none");
      // Render v3 summary using existing renderSummary (supports short_description, long_summary, title, keywords)
      $(contentRef).update(renderSummary(summary as SummaryResult));
      // Defer innerHTML to next frame — use querySelector since defuss doesn't attach nested refs
      requestAnimationFrame(() => {
        const mdEl = contentRef.current?.querySelector('.markdown-content');
        if (mdEl && ls) {
          (mdEl as HTMLElement).innerHTML = renderMarkdown(ls);
        }
      });
    },
    clear: () => {
      $(contentRef).update(renderEmpty());
    },
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" ref={ref}>
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {renderEmpty()}
      </div>
    </div>
  );
};
