import { AutomergeUrl } from "@automerge/automerge-repo";
import { useDocument, useHandle } from "@automerge/automerge-repo-react-hooks";
import { DiffStyle, MarkdownEditor, TextSelection } from "./MarkdownEditor";

import {
  AnnotationPosition,
  DiffWithProvenance,
  DraftAnnotation,
  MarkdownDoc,
  TextAnnotation,
} from "../schema";
import { LoadingScreen } from "../../DocExplorer/components/LoadingScreen";
import { useEffect, useRef, useState } from "react";

import { EditorView } from "@codemirror/view";
import { CommentsSidebar } from "./CommentsSidebar";
import { getRelativeTimeString, useAnnotationsWithPositions } from "../utils";

// TODO: audit the CSS being imported here;
// it should be all 1) specific to TEE, 2) not dependent on viewport / media queries
import "../../tee/index.css";
import { Heads, getHeads, view } from "@automerge/automerge/next";
import { Button } from "@/components/ui/button";
import { ShrinkIcon } from "lucide-react";
import { ContactAvatar } from "@/DocExplorer/components/ContactAvatar";
import { truncate } from "lodash";
import { createOrGrowEditGroup } from "@/chronicle/editGroups";

export const TinyEssayEditor = ({
  docUrl,
  docHeads,
  diff,
  readOnly,
  diffStyle,
  foldRanges,
  showDiffAsComments,
  diffBase,
}: {
  docUrl: AutomergeUrl;
  docHeads?: Heads;
  diff?: DiffWithProvenance;
  readOnly?: boolean;
  diffStyle?: DiffStyle;
  foldRanges?: { from: number; to: number }[];
  showDiffAsComments?: boolean;
  diffBase?: Heads;
}) => {
  const [doc, changeDoc] = useDocument<MarkdownDoc>(docUrl); // used to trigger re-rendering when the doc loads
  const handle = useHandle<MarkdownDoc>(docUrl);
  const [selection, setSelection] = useState<TextSelection>();
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>(
    []
  );
  const [editorView, setEditorView] = useState<EditorView>();
  const editorRef = useRef<HTMLDivElement>(null);
  const [visibleAnnotationTypes, setVisibleAnnotationTypes] = useState<
    TextAnnotation["type"][]
  >(["thread", "draft", "patch"]);

  const annotationsWithPositions = useAnnotationsWithPositions({
    doc,
    view: editorView,
    selectedAnnotationIds: selectedAnnotationIds,
    editorRef,
    diff: showDiffAsComments ? diff : undefined,
    diffBase,
    visibleAnnotationTypes,
  });

  // keyboard shortcuts
  useEffect(() => {
    const keydownHandler = (event: KeyboardEvent) => {
      // Group edit groups with cmd-g
      if (event.key === "g" && event.metaKey) {
        createOrGrowEditGroup(
          selectedAnnotationIds.map((id) =>
            annotationsWithPositions.find((a) => a.id === id)
          ),
          changeDoc
        );
      }
    };

    window.addEventListener("keydown", keydownHandler);

    // Clean up listener on unmount
    return () => {
      window.removeEventListener("keydown", keydownHandler);
    };
  }, [selectedAnnotationIds, annotationsWithPositions, changeDoc]);

  // todo: remove from this component and move up to DocExplorer?
  if (!doc) {
    return <LoadingScreen docUrl={docUrl} handle={handle} />;
  }

  const annotations = annotationsWithPositions;

  // only show a diff in the text editor if we have edits or edit groups on in the sidebar
  const patchesForEditor =
    diff &&
    (visibleAnnotationTypes.includes("draft") ||
      visibleAnnotationTypes.includes("patch"))
      ? diff.patches
      : undefined;

  const docAtHeads = docHeads ? view(doc, docHeads) : doc;
  return (
    <div className="h-full overflow-auto" ref={editorRef}>
      <div className="@container flex bg-gray-50 justify-center">
        {/* This has some subtle behavior for responsiveness.
            - We use container queries to adjust the width of the editor based on the size of our container.
            - We get the right line width by hardcoding a max-width and x-padding
            - We take over the full screen on narrow displays (showing comments on mobile is TODO)
         */}
        <div className="bg-white border border-gray-200 box-border rounded-md w-full @xl:w-4/5 @xl:mt-4 @xl:mr-2 @xl:mb-8 max-w-[722px]  @xl:ml-[-100px] @4xl:ml-[-200px] px-8 py-4 ">
          <MarkdownEditor
            handle={handle}
            path={["content"]}
            setSelection={setSelection}
            setView={setEditorView}
            threadsWithPositions={annotations}
            setActiveThreadIds={setSelectedAnnotationIds}
            readOnly={readOnly ?? false}
            docHeads={docHeads}
            diff={patchesForEditor}
            diffStyle={diffStyle ?? "normal"}
            foldRanges={foldRanges}
          />
        </div>
        <div className="w-0">
          <CommentsSidebar
            doc={docAtHeads}
            changeDoc={changeDoc}
            selection={selection}
            selectedAnnotationIds={selectedAnnotationIds}
            setSelectedAnnotationIds={setSelectedAnnotationIds}
            annotationsWithPositions={annotations}
            diff={diff}
            visibleAnnotationTypes={visibleAnnotationTypes}
            setVisibleAnnotationTypes={setVisibleAnnotationTypes}
          />
        </div>
      </div>
    </div>
  );
};
