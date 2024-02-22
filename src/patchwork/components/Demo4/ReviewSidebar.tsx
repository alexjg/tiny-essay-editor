import { MarkdownDoc } from "@/tee/schema";
import { AutomergeUrl } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge/next";
import {
  useDocument,
  useHandle,
  useRepo,
} from "@automerge/automerge-repo-react-hooks";
import React, { useEffect, useMemo, useRef, useState, ReactNode } from "react";
import {
  ChangeGroup,
  getGroupedChanges,
  getMarkersForDoc,
} from "../../groupChanges";

import {
  MessageSquare,
  MilestoneIcon,
  SendHorizontalIcon,
  MergeIcon,
} from "lucide-react";
import { Heads } from "@automerge/automerge/next";
import { InlineContactAvatar } from "@/DocExplorer/components/InlineContactAvatar";
import { DiffWithProvenance, DiscussionComment } from "../../schema";
import { useCurrentAccount } from "@/DocExplorer/account";
import { Button } from "@/components/ui/button";
import { uuid } from "@automerge/automerge";
import { useSlots } from "@/patchwork/utils";
import { TextSelection } from "@/tee/components/MarkdownEditor";
import { EditRange } from "@/tee/schema";

export type HistoryZoomLevel = 1 | 2 | 3;

type MilestoneSelection = {
  type: "milestone";
  heads: Heads;
};

// the data structure that represents the range of change groups we've selected for showing diffs.
type ChangeGroupSelection = {
  type: "changeGroups";
  /** The older (causally) change group in the selection */
  from: ChangeGroup["id"];

  /** The newer (causally) change group in the selection */
  to: ChangeGroup["id"];
};

type Selection = MilestoneSelection | ChangeGroupSelection;

const useScrollToBottom = () => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [scrollerRef.current]);
  return scrollerRef;
};

export const ReviewSidebar: React.FC<{
  docUrl: AutomergeUrl;
  setDocHeads: (heads: Heads) => void;
  setDiff: (diff: DiffWithProvenance) => void;
  zoomLevel: HistoryZoomLevel;
  textSelection: TextSelection;
  onClearTextSelection: () => void;
}> = ({
  docUrl,
  setDocHeads,
  setDiff,
  zoomLevel,
  textSelection,
  onClearTextSelection,
}) => {
  const [doc, changeDoc] = useDocument<MarkdownDoc>(docUrl);
  const handle = useHandle<MarkdownDoc>(docUrl);
  const repo = useRepo();
  const account = useCurrentAccount();
  const scrollerRef = useScrollToBottom();

  const [commentBoxContent, setCommentBoxContent] = useState("");

  // TODO: technically this should also update when the "source doc" for this branch updates
  const markers = useMemo(
    () => getMarkersForDoc(handle, repo),
    // Important to have doc as a dependency here even though the linter says not needed
    [doc, handle, repo]
  );

  // The grouping function returns change groups starting from the latest change.
  const { groupedChanges } = useMemo(() => {
    if (!doc) return { groupedChanges: [], changeCount: 0 };

    let algorithm = "ByAuthor";
    let numericParameter = 100;

    switch (zoomLevel) {
      case 1:
        algorithm = "ByEditTime";
        numericParameter = 180;
        break;
      case 2:
        algorithm = "ByAuthorOrTime";
        numericParameter = 60;
        break;
      case 3:
        algorithm = "ByAuthorOrTime";
        numericParameter = 1;
        break;
      default:
        break;
    }

    const { changeCount, changeGroups } = getGroupedChanges(doc, {
      algorithm,
      numericParameter,
      markers,
    });

    return {
      changeCount,
      groupedChanges: changeGroups,
    };
  }, [doc, markers, zoomLevel]);

  /** If there's a marker that specifies "hide history before this", we
   *  collapse change groups before that point by default.
   */
  const lastHiddenChangeGroupIndex = markers.some(
    (m) => m.hideHistoryBeforeThis
  )
    ? /** TODO: in the case of multiple markers with the flag set;
       *  this logic will only hide before the first such marker;
       *  unclear if this is what we want? See how it works in real cases;
       *  we don't actually have a use case where it matters yet.
       */
      groupedChanges.findIndex((g) =>
        g.markers.some((m) => m.hideHistoryBeforeThis)
      )
    : -1;

  const [showHiddenChangeGroups, setShowHiddenChangeGroups] = useState(false);

  const [selection, setSelection] = useState<Selection | null>();

  const selectedChangeGroups: ChangeGroup[] = useMemo(() => {
    if (selection && selection.type === "changeGroups") {
      const fromIndex = groupedChanges.findIndex(
        (changeGroup) => changeGroup.id === selection.from
      );
      const toIndex = groupedChanges.findIndex(
        (changeGroup) => changeGroup.id === selection.to
      );
      return groupedChanges.slice(fromIndex, toIndex + 1);
    } else {
      return [];
    }
  }, [selection, groupedChanges]);

  // TODO: is the heads for a group always the id of the group?
  // for now it works because the id of the group is the last change in the group...
  const docHeads = useMemo(() => {
    if (!selection) return [];
    switch (selection.type) {
      case "milestone":
        return selection.heads;
      case "changeGroups":
        return [selection.to];
    }
  }, [selection]);

  // sync the diff and docHeads up to the parent component when the selection changes
  useEffect(() => {
    if (selection?.type === "changeGroups") {
      const diff = {
        fromHeads: selectedChangeGroups[0]?.diff.fromHeads,
        toHeads:
          selectedChangeGroups[selectedChangeGroups.length - 1]?.diff.toHeads,
        patches: selectedChangeGroups.flatMap((cg) => cg.diff.patches),
      };
      setDiff(diff);
      setDocHeads(docHeads);
    } else if (selection?.type === "milestone") {
      setDocHeads(selection.heads);
      setDiff({
        patches: [],
        fromHeads: selection.heads,
        toHeads: selection.heads,
      });
    } else {
      setDocHeads(undefined);
      setDiff(undefined);
    }
  }, [selectedChangeGroups, setDiff, setDocHeads, docHeads]);

  const handleClickOnChangeGroup = (
    e: React.MouseEvent,
    changeGroup: ChangeGroup
  ) => {
    // For normal clicks without the shift key, we just select one change.
    if (!e.shiftKey) {
      setSelection({
        type: "changeGroups",
        from: changeGroup.id,
        to: changeGroup.id,
      });
      return;
    }

    // If the shift key is pressed, we create a multi-change selection.
    // If there's no existing change group selected, just use the latest as the starting point for the selection.
    if (!selection || selection.type === "milestone") {
      setSelection({
        type: "changeGroups",
        from: changeGroup.id,
        to: groupedChanges[groupedChanges.length - 1].id,
      });
      return;
    }

    // Extend the existing range selection appropriately

    const indexOfSelectionFrom =
      selection.type === "changeGroups"
        ? groupedChanges.findIndex((c) => c.id === selection.from)
        : -1;

    const indexOfSelectionTo =
      selection.type === "changeGroups"
        ? groupedChanges.findIndex((c) => c.id === selection.to)
        : -1;

    const indexOfClickedChangeGroup = groupedChanges.findIndex(
      (c) => c.id === changeGroup.id
    );

    if (indexOfClickedChangeGroup < indexOfSelectionFrom) {
      setSelection({
        type: "changeGroups",
        from: changeGroup.id,
        to: selection.to,
      });
      return;
    }

    if (indexOfClickedChangeGroup > indexOfSelectionTo) {
      setSelection({
        type: "changeGroups",
        from: selection.from,
        to: changeGroup.id,
      });
      return;
    }

    setSelection({
      type: "changeGroups",
      from: selection.from,
      to: changeGroup.id,
    });
  };

  // When the user selects a heads in the history,
  // some change groups get "hiddden", meaning the contents of the group
  // aren't visible in the displayed doc.
  const headIsVisible = (head: string) => {
    if (!selection) return true;
    const lastVisibleChangeGroupId =
      selection.type === "changeGroups"
        ? selection.to
        : groupedChanges.find((cg) => cg.id === selection.heads[0]).id;
    return (
      groupedChanges.map((c) => c.id).indexOf(lastVisibleChangeGroupId) >=
      groupedChanges.map((c) => c.id).indexOf(head)
    );
  };

  // There are 3 cases
  // - a milestone is selected -> use the heads of the milestone
  // - a change group (range) is selected -> use the heads of the changegroup
  // - nothing is selected -> use the heads of the latest changegroup
  //
  // we use the current active heads to assign comments
  const currentlyActiveHeads = useMemo<A.Heads>(() => {
    if (!selection) {
      if (groupedChanges.length === 0) {
        return null;
      }

      const latestChangeGroup = groupedChanges[groupedChanges.length - 1];
      return A.getHeads(latestChangeGroup.docAtEndOfChangeGroup);
    }

    if (selection.type === "milestone") {
      return selection.heads;
    }

    if (selection.type === "changeGroups") {
      const selectedChangeGroup = groupedChanges.find(
        (group) => group.id === selection.to
      );
      return A.getHeads(selectedChangeGroup.docAtEndOfChangeGroup);
    }
  }, [groupedChanges, selection]);

  const createDiscussion = () => {
    if (commentBoxContent === "") {
      return;
    }

    /** migration for legacy docs */

    const comment: DiscussionComment = {
      id: uuid(),
      content: commentBoxContent,
      timestamp: Date.now(),
      contactUrl: account?.contactHandle?.url,
    };
    const discussionId = uuid();

    let target: EditRange = undefined;
    if (textSelection && textSelection.from !== textSelection.to) {
      target = {
        fromCursor: A.getCursor(doc, ["content"], textSelection.from),
        toCursor: A.getCursor(doc, ["content"], textSelection.to),
      };
    }

    changeDoc((doc) => {
      if (!doc.discussions) {
        doc.discussions = {};
      }

      doc.discussions[discussionId] = {
        id: discussionId,
        heads: currentlyActiveHeads,
        resolved: false,
        comments: [comment],
      };

      if (target) {
        doc.discussions[discussionId].target = target;
      }
    });

    onClearTextSelection();
    setCommentBoxContent("");
  };

  return (
    <div className="h-full w-96 border-r border-gray-200 overflow-y-hidden flex flex-col text-xs font-semibold text-gray-600 history bg-neutral-100">
      <div
        ref={scrollerRef}
        className="overflow-auto pt-3 flex-grow flex flex-col pb-4"
      >
        <div className="mt-auto">
          {lastHiddenChangeGroupIndex >= 0 && !showHiddenChangeGroups && (
            <div className="text-xs text-gray-500 pl-2 mb-2">
              {lastHiddenChangeGroupIndex + 1} changes hidden
              <span
                className="text-gray-500 hover:text-gray-700 underline cursor-pointer ml-2"
                onClick={() => setShowHiddenChangeGroups(true)}
              >
                Show
              </span>
            </div>
          )}
          {groupedChanges.map((changeGroup, index) => {
            // GL note 2/13
            // The logic here is a bit weird because of how we associate markers and change groups.
            // Mostly, hiding groups is straightforward. We just don't show groups before the hidden index.
            // But at the boundary things get odd.
            // A marker is associated with the change group before it.
            // When we hide changes, we want to show the marker after the last hidden group, but we don't want to show the last hidden group.
            // This means that for the last hidden group, we hide the contents but show the marker.
            // It's possible that markers should live more on their own in the grouping list, or maybe even be associated with the group after them..?
            // But neither of those are obviously better than associating a marker with a group before, so we're sticking with this for now.

            const hideGroupEntirely =
              index < lastHiddenChangeGroupIndex && !showHiddenChangeGroups;

            const hideGroupButShowMarkers =
              index === lastHiddenChangeGroupIndex && !showHiddenChangeGroups;

            if (hideGroupEntirely) {
              return null;
            }

            const isABranchMergeGroup = changeGroup.markers.some(
              (m) => m.type === "otherBranchMergedIntoThisDoc"
            );

            const selected = selectedChangeGroups.includes(changeGroup);

            return (
              <div key={changeGroup.id}>
                <div className="relative">
                  {new Date(changeGroup.time).toDateString() !==
                    new Date(
                      groupedChanges[index - 1]?.time
                    ).toDateString() && (
                    <div className="text-sm font-medium text-gray-400 px-4 flex items-center justify-between p-1 w-full">
                      <hr className="flex-grow border-t border-gray-200 mr-2 ml-4" />
                      <div>
                        {changeGroup.time &&
                          new Date(changeGroup.time).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            weekday: "short",
                          })}
                        {!changeGroup.time && "Unknown time"}
                      </div>
                    </div>
                  )}
                  {lastHiddenChangeGroupIndex === index &&
                    showHiddenChangeGroups && (
                      <div className="text-xs text-gray-500 pl-2 my-2">
                        <span
                          className="text-gray-500 hover:text-gray-700 underline cursor-pointer ml-2"
                          onClick={() => setShowHiddenChangeGroups(false)}
                        >
                          Hide changes before this
                        </span>
                      </div>
                    )}
                  {!hideGroupButShowMarkers && !isABranchMergeGroup && (
                    <div
                      className={`relative group px-1 pt-3 w-full overflow-y-hidden cursor-default border-l-4 border-l-transparent select-none `}
                      data-id={changeGroup.id}
                      key={changeGroup.id}
                      onClick={(e) => {
                        handleClickOnChangeGroup(e, changeGroup);
                      }}
                    >
                      {selection?.type === "changeGroups" &&
                        selection.to === changeGroup.id &&
                        changeGroup.markers.filter((m) => m.type === "tag")
                          .length === 0 &&
                        index !== 0 && (
                          <div
                            className="absolute top-0 right-2 bg-white border border-gray-300 px-1 cursor-pointer hover:bg-gray-50 text-xs"
                            onClick={() => {
                              changeDoc((doc) => {
                                if (!doc.tags) {
                                  doc.tags = [];
                                }
                                doc.tags.push({
                                  name: window.prompt("Tag name:"),
                                  heads: [changeGroup.id],
                                  createdAt: Date.now(),
                                  createdBy: account?.contactHandle?.url,
                                });
                              });
                            }}
                          >
                            <MilestoneIcon
                              size={12}
                              className="inline-block mr-1"
                            />
                            Save milestone
                          </div>
                        )}

                      <div className="ml-[16px]">
                        <EditSummary
                          changeGroup={changeGroup}
                          selected={selected}
                        />
                      </div>
                    </div>
                  )}
                  {changeGroup.markers.map((marker) => (
                    <div
                      key={marker.heads[0]}
                      className={`text-xs text-gray-500 p-2  select-none  ${
                        headIsVisible(marker.heads[0]) ? "" : "opacity-50"
                      }`}
                      // todo: we should generalize selection to any kind of marker
                      onClick={() => {
                        setSelection({
                          type: "milestone",
                          heads: marker.heads,
                        });
                      }}
                    >
                      {marker.type === "discussionThread" &&
                        /* todo: support multiple comments */
                        marker.discussion.comments.map((comment) => {
                          return (
                            <ItemView selected={selected}>
                              <ItemIcon>
                                <MessageSquare
                                  className="h-[10px] w-[10px] text-white"
                                  strokeWidth={2}
                                />
                              </ItemIcon>
                              <ItemContent>
                                <div className="text-sm">
                                  <div className=" text-gray-600 inline">
                                    <InlineContactAvatar
                                      url={comment.contactUrl}
                                      size="sm"
                                    />
                                  </div>
                                  {marker.discussion.target && (
                                    <HighlightSnippetView
                                      text={
                                        changeGroup.docAtEndOfChangeGroup
                                          .content
                                      }
                                      from={A.getCursorPosition(
                                        changeGroup.docAtEndOfChangeGroup,
                                        ["content"],
                                        marker.discussion.target.fromCursor
                                      )}
                                      to={A.getCursorPosition(
                                        changeGroup.docAtEndOfChangeGroup,
                                        ["content"],
                                        marker.discussion.target.toCursor
                                      )}
                                    />
                                  )}

                                  <div className="font-normal pl-3">
                                    {comment.content}
                                  </div>
                                </div>
                              </ItemContent>
                            </ItemView>
                          );
                        })}
                      {marker.type === "tag" && (
                        <div
                          className={`cursor-pointer items-top flex gap-1 rounded-full -ml-1 pl-1 border-2 border-gray-300 shadow-sm ${
                            selection?.type === "milestone" &&
                            selection?.heads === marker.heads
                              ? "bg-gray-200"
                              : "bg-gray-100"
                          }`}
                        >
                          <div className="mt-1.5 flex h-[16px] w-[16px] items-center justify-center rounded-full bg-orange-500 outline outline-2 outline-gray-100">
                            <MilestoneIcon
                              className="h-[10px] w-[10px] text-white"
                              strokeWidth={2}
                            />
                          </div>

                          <div className="flex-1 p-1 text-sm flex">
                            <div className="font-semibold">
                              {marker.tag.name}
                            </div>
                            {marker.tag.createdBy && (
                              <div className=" text-gray-600 ml-auto">
                                <InlineContactAvatar
                                  key={marker.tag.createdBy}
                                  url={marker.tag.createdBy}
                                  size="sm"
                                  showName={false}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {marker.type === "originOfThisBranch" && (
                        <div>
                          <div className="text-sm">
                            {marker.branch.createdBy && (
                              <div className=" text-gray-600 inline">
                                <InlineContactAvatar
                                  key={marker.branch.createdBy}
                                  url={marker.branch.createdBy}
                                  size="sm"
                                />
                              </div>
                            )}{" "}
                            <div className="inline font-normal">
                              started this branch:
                            </div>{" "}
                            <div className="inline font-semibold">
                              {marker.branch.name}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {isABranchMergeGroup && (
                    <MergedBranchView
                      changeGroup={changeGroup}
                      selected={selected}
                      setSelection={setSelection}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div
          className={`flex cursor-pointer items-center text-gray-400 font-semibold mt-1.5  ${
            docHeads.length > 0 ? "opacity-50" : ""
          }`}
          onClick={() => setSelection(null)}
        >
          <div className="ml-[8px] bg-gray-200 rounded-full h-[16px] w-[16px]"></div>
          <div className="ml-2">Now</div>
        </div>
      </div>

      <div className="pt-4 border-t border-gray-300 shadow-upward bg-white z-10">
        {textSelection && textSelection.from !== textSelection.to && (
          <HighlightSnippetView
            from={textSelection.from}
            to={textSelection.to}
            text={doc.content}
          />
        )}

        <div className="mx-2">
          <textarea
            value={commentBoxContent}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                createDiscussion();
              }
            }}
            onChange={(e) => setCommentBoxContent(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md h-16"
            placeholder="Leave a comment..."
          />
          <div className="flex justify-end mt-2 text-sm">
            <div className="flex items-center">
              <Button variant="ghost" onClick={createDiscussion}>
                <SendHorizontalIcon size={14} className="mr-1" />
                Send
                <span className="text-gray-400 text-xs ml-1">⌘+enter</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const EditSummary = ({
  changeGroup,
  selected,
}: {
  changeGroup: ChangeGroup;
  selected: boolean;
}) => {
  return (
    <div
      className={`group cursor-pointer  p-1 rounded-full font-bold flex ${
        selected ? "bg-blue-100 bg-opacity-50" : "bg-transparent"
      } `}
    >
      <span
        className={`text-green-600  mr-2 ${
          changeGroup.charsAdded === 0 && "opacity-50"
        }`}
      >
        +{changeGroup.charsAdded}
      </span>
      <span
        className={`text-red-600 mr-2 ${
          !changeGroup.charsDeleted && "opacity-50"
        }`}
      >
        -{changeGroup.charsDeleted || 0}
      </span>
      <span
        className={`text-gray-500 ${
          changeGroup.commentsAdded === 0 && "opacity-50"
        }`}
      >
        💬{changeGroup.commentsAdded}
      </span>

      <div className="ml-auto">
        {changeGroup.authorUrls.length > 0 && (
          <div className=" text-gray-600 inline">
            {changeGroup.authorUrls.map((contactUrl) => (
              <div className="inline">
                <InlineContactAvatar
                  key={contactUrl}
                  url={contactUrl}
                  size="sm"
                  showName={false}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const MergedBranchView: React.FC<{
  changeGroup: ChangeGroup;
  selected: boolean;
  setSelection: (s: Selection) => void;
}> = ({ changeGroup, selected, setSelection }) => {
  const branch = changeGroup.markers.find(
    (m) => m.type === "otherBranchMergedIntoThisDoc"
    // @ts-expect-error -- this should be fine, why does TS not get it?
  ).branch;
  return (
    <div
      className="ml-[8px]"
      onClick={() =>
        setSelection({
          type: "changeGroups",
          from: changeGroup.id,
          to: changeGroup.id,
        })
      }
    >
      <ItemView selected={selected}>
        <ItemIcon>
          <MergeIcon className="h-[10px] w-[10px] text-white" strokeWidth={2} />
        </ItemIcon>

        <ItemContent>
          <div className="text-sm flex select-none">
            <div>
              <div className="inline font-semibold">{branch.name}</div>{" "}
              <div className="inline font-normal">was merged</div>
            </div>
            <div className="ml-auto">
              {branch.mergeMetadata!.mergedBy && (
                <div className=" text-gray-600 inline">
                  <InlineContactAvatar
                    key={branch.mergeMetadata!.mergedBy}
                    url={branch.mergeMetadata!.mergedBy}
                    size="sm"
                    showName={false}
                  />
                </div>
              )}
            </div>
          </div>
        </ItemContent>
      </ItemView>
      <div className="mt-1 flex gap-1">
        <div className="ml-8 w-3 h-3 border-b-2 border-l-2 border-gray-300 rounded-bl-full"></div>
        <EditSummary changeGroup={changeGroup} selected={selected} />
      </div>
    </div>
  );
};

interface HighlightSnippetViewProps {
  from: number;
  to: number;
  text: string;
}

const SNIPPET_CUTOFF = 75;

const STOP_CHARACTER = [".", "!", "?", "\n"];

const HighlightSnippetView = ({
  from,
  to,
  text,
}: HighlightSnippetViewProps) => {
  let start = from;
  let startWithEllipsis = true;
  while (start > 0) {
    if (STOP_CHARACTER.includes(text.charAt(start - 1))) {
      startWithEllipsis = false;
      break;
    }

    // make sure we don't cut in the middle of a word
    if (from - start - 1 === SNIPPET_CUTOFF) {
      while (text.charAt(start) !== " ") {
        start++;
      }
      break;
    }

    start--;
  }

  let end = from;
  let endWithEllipsis = true;
  while (end < text.length) {
    if (STOP_CHARACTER.includes(text.charAt(end))) {
      endWithEllipsis = false;
      break;
    }

    // make sure we don't cut in the middle of a word
    if (end - to + 1 === SNIPPET_CUTOFF) {
      while (text.charAt(end) !== " ") {
        end--;
      }
      break;
    }

    end++;
  }

  const before = startWithEllipsis
    ? `...${text.slice(start, from)}`
    : text.slice(start, from).trimStart();
  const highlight = text.slice(from, to);
  const after = endWithEllipsis
    ? `${text.slice(to, end)}...`
    : text.slice(to, end).trimEnd();

  return (
    <div
      className="border-l-2 border-l border-gray-200 p-2 m-2 whitespace-pre-wrap cm-line font-normal"
      style={{ fontFamily: "Merriweather, serif" }}
    >
      {before}
      <span style={{ background: "rgb(255 249 194)" }}>{highlight}</span>
      {after}
    </div>
  );
};

const ItemIcon = ({ children }: { children: ReactNode }) => <>{children}</>;
const ItemContent = ({ children }: { children: ReactNode }) => <>{children}</>;

const ItemView = ({
  selected,
  children,
}: {
  selected: boolean;
  children: ReactNode | ReactNode[];
}) => {
  const [slots] = useSlots(children, { icon: ItemIcon, content: ItemContent });

  return (
    <div className="items-top flex gap-1">
      {slots.icon && (
        <div className="mt-1.5 flex h-[16px] w-[16px] items-center justify-center rounded-full bg-purple-600 outline outline-2 outline-gray-100">
          {slots.icon}
        </div>
      )}

      {!slots.icon && <div className="w-[16px] h-[16px] mt-1.5" />}
      <div
        className={`cursor-pointer flex-1 rounded p-1 shadow ${
          selected ? "bg-blue-100" : "bg-white"
        }`}
      >
        {slots.content}
      </div>
    </div>
  );
};