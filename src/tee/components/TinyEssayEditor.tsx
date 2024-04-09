import { next as A } from "@automerge/automerge";
import { AutomergeUrl } from "@automerge/automerge-repo";
import { useDocument, useHandle } from "@automerge/automerge-repo-react-hooks";
import { MarkdownEditor } from "./MarkdownEditor";

import { useEffect, useMemo, useState } from "react";
import { LoadingScreen } from "../../DocExplorer/components/LoadingScreen";
import {
  MarkdownDoc,
  MarkdownDocAnchor,
  ResolvedMarkdownDocAnchor,
} from "../schema";

import { PatchWithAttr } from "@automerge/automerge-wasm";
import { EditorView } from "@codemirror/view";
import { ReviewStateFilter } from "../utils";

// TODO: audit the CSS being imported here;
// it should be all 1) specific to TEE, 2) not dependent on viewport / media queries
import { useCurrentAccount } from "@/DocExplorer/account";
import { DocEditorProps } from "@/DocExplorer/doctypes";
import { AnnotationWithState } from "@/patchwork/schema";
import { TextPatch, getCursorPositionSafely } from "@/patchwork/utils";
import { Patch, view } from "@automerge/automerge/next";
import { isEqual, uniq } from "lodash";
import "../../tee/index.css";

export const TinyEssayEditor = (
  props: DocEditorProps<MarkdownDocAnchor, string>
) => {
  const {
    docUrl,
    docHeads,
    annotations = [],
    setSelectedAnchors,
    actorIdToAuthor,
  } = props;

  const account = useCurrentAccount();
  const [doc, changeDoc] = useDocument<MarkdownDoc>(docUrl); // used to trigger re-rendering when the doc loads
  const handle = useHandle<MarkdownDoc>(docUrl);
  const [editorView, setEditorView] = useState<EditorView>();
  const [isCommentBoxOpen, setIsCommentBoxOpen] = useState(false);
  const [editorContainer, setEditorContainer] = useState<HTMLDivElement>(null);
  const readOnly = docHeads && !isEqual(docHeads, A.getHeads(doc));

  const [visibleAuthorsForEdits, setVisibleAuthorsForEdits] = useState<
    AutomergeUrl[]
  >([]);

  // If the authors on the doc change, show changes by all authors
  useEffect(() => {
    setVisibleAuthorsForEdits(uniq(Object.values(actorIdToAuthor ?? {})));
  }, [actorIdToAuthor]);

  // focus annotation
  /* useEffect(() => {
    let focusedDiscussion: Discussion;

    if (selection && selection.from === selection.to) {
      focusedDiscussion = (discussions ?? []).find((discussion) => {
        if (!discussion.target || discussion.target.type !== "editRange") {
          return false;
        }

        const from = A.getCursorPosition(
          doc,
          ["content"],
          discussion.target.value.fromCursor
        );
        const to = A.getCursorPosition(
          doc,
          ["content"],
          discussion.target.value.toCursor
        );

        return from <= selection.from && selection.from <= to;
      });

      if (focusedDiscussion) {
        setSelectedDiscussionId(focusedDiscussion.id);
      }
    }
  }, [discussions, doc, selection, setSelectedDiscussionId]); */

  const resolvedAnnotations = useMemo<
    AnnotationWithState<ResolvedMarkdownDocAnchor, string>[]
  >(() => {
    return annotations.flatMap((annotation) => {
      const { fromCursor, toCursor } = annotation.target;
      const fromPos = getCursorPositionSafely(doc, ["content"], fromCursor);
      const toPos = getCursorPositionSafely(doc, ["content"], toCursor);

      return !fromPos || !toPos
        ? []
        : [
            {
              ...annotation,
              target: { fromPos, toPos, fromCursor, toCursor },
            },
          ];
    });
  }, [doc, annotations]);

  // todo: remove from this component and move up to DocExplorer?
  if (!doc) {
    return <LoadingScreen docUrl={docUrl} handle={handle} />;
  }

  return (
    <div
      className="h-full overflow-auto min-h-0 w-full"
      ref={setEditorContainer}
    >
      <div className="@container flex bg-gray-100 justify-center">
        {/* This has some subtle behavior for responsiveness.
            - We use container queries to adjust the width of the editor based on the size of our container.
            - We get the right line width by hardcoding a max-width and x-padding
            - We take over the full screen on narrow displays (showing comments on mobile is TODO)
         */}
        <div className="flex @xl:mt-4 @xl:mr-2 @xl:mb-8 @xl:ml-[-100px] @4xl:ml-[-200px] w-full @xl:w-4/5  max-w-[722px]">
          <div
            className={`w-full bg-white box-border rounded-md px-8 py-4 transition-all duration-500 ${
              readOnly
                ? " border-2 border-dashed border-slate-400"
                : "border border-gray-200 "
            }`}
          >
            <MarkdownEditor
              editorContainer={editorContainer}
              diffStyle="normal"
              handle={handle}
              path={["content"]}
              setSelectedAnchors={setSelectedAnchors}
              setView={setEditorView}
              annotations={resolvedAnnotations}
              readOnly={readOnly ?? false}
              docHeads={docHeads}
              isCommentBoxOpen={isCommentBoxOpen}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const getPatchLength = (
  patch: Patch | PatchWithAttr<AutomergeUrl> | TextPatch
) => {
  switch (patch.action) {
    case "del":
      return patch.length;
    case "splice":
      return patch.value.length;
    case "replace":
      return patch.raw.splice.value.length;
  }
};
