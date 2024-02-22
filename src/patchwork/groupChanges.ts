// This file puts changes from a doc into groups for display in the UI.
// There are various algorithms that can govern what makes a group.
// It can accept manual markers to split groups.

// It also calculates some stats for each group, both generic to all docs
// as well as calling out to some datatype-specific summarization.
// (For now, the datatype is fixed to MarkdownDoc, but there is a clear boundary;
// the TEE code defines MarkdownDoc-specific stats.)

// Known issues:
// - getAllChanges returns different orders on different devices;
//   we should define a total order for changes across all devices.

import { MarkdownDoc } from "@/tee/schema";
import {
  Branch,
  Branchable,
  DiffWithProvenance,
  Discussable,
  Discussion,
  Tag,
  Taggable,
} from "./schema";
import { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import {
  Doc,
  decodeChange,
  ActorId,
  DecodedChange,
  getAllChanges,
  view,
  getHeads,
} from "@automerge/automerge/next";
import { diffWithProvenance } from "./utils";
import {
  ChangeMetadata,
  DocHandle,
} from "@automerge/automerge-repo/dist/DocHandle";
import { Hash, Heads } from "@automerge/automerge-wasm"; // todo: should be able to import from @automerge/automerge
import {
  MarkdownDocChangeGroup,
  showChangeGroupInLog,
  statsForChangeGroup,
} from "@/tee/statsForChangeGroup";
import { getChangesFromMergedBranch } from "./branches";
import { isEqual } from "lodash";

interface DecodedChangeWithMetadata extends DecodedChange {
  metadata: ChangeMetadata;
}

/** A marker of a significant moment in the doc history */
export type HeadsMarker = { heads: Heads; hideHistoryBeforeThis?: boolean } & (
  | { type: "tag"; tag: Tag }
  | { type: "otherBranchMergedIntoThisDoc"; branch: Branch }
  | { type: "branchCreatedFromThisDoc"; branch: Branch }
  | {
      type: "originOfThisBranch";
      source: Branchable["branchMetadata"]["source"];
      branch: Branch;
    }
  | { type: "discussionThread"; discussion: Discussion }
);

/** Change group attributes that could work for any document */
export type GenericChangeGroup = {
  id: string;
  changes: DecodedChangeWithMetadata[];
  actorIds: ActorId[];
  authorUrls: AutomergeUrl[];
  // TODO make this a generic type --
  // making it Doc<unknown> highlights the places where we currently expect
  // this to be a MarkdownDoc that need to be generalized more.
  docAtEndOfChangeGroup: Doc<MarkdownDoc>;
  diff: DiffWithProvenance;
  markers: HeadsMarker[];
  time?: number;
};

export type ChangeGroup = GenericChangeGroup & MarkdownDocChangeGroup;

type GroupingAlgorithm = (
  currentGroup: ChangeGroup,
  newChange: DecodedChangeWithMetadata,
  numericParameter: number
) => boolean;

// A grouping algorithm returns a boolean denoting whether the new change should be added to the current group.
// Some of these algorithms rely on MarkdownDoc-specific stats; need to generalize that further.
export const GROUPINGS: { [key in string]: GroupingAlgorithm } = {
  ByActorAndNumChanges: (currentGroup, newChange, batchSize) => {
    return (
      currentGroup.actorIds[0] === newChange.actor &&
      currentGroup.changes.length < batchSize
    );
  },
  ByActor: (currentGroup, newChange) => {
    return currentGroup.actorIds[0] === newChange.actor;
  },
  ByAuthor: (currentGroup, newChange) => {
    if (!newChange.metadata?.author) {
      return true;
    }
    return currentGroup.authorUrls.includes(
      newChange.metadata?.author as AutomergeUrl
    );
  },
  ByNumberOfChanges: (
    currentGroup: ChangeGroup,
    newChange: DecodedChangeWithMetadata,
    batchSize: number
  ) => {
    return currentGroup.changes.length < batchSize;
  },
  ByCharCount: (
    currentGroup: ChangeGroup,
    newChange: DecodedChangeWithMetadata,
    batchSize: number
  ) => {
    return currentGroup.charsAdded + currentGroup.charsDeleted < batchSize;
  },

  // This always combines everything into one group,
  // so we only end up splitting when there's a manual tag
  ByTagsOnly: () => true,

  // "batch size" param here means "max gap allowed, in ms"
  //
  ByEditTime: (currentGroup, newChange, maxGapInMinutes) => {
    if (
      (newChange.time === undefined || newChange.time === 0) &&
      (currentGroup.time === undefined || currentGroup.time === 0)
    ) {
      return true;
    }

    return newChange.time < currentGroup.time + maxGapInMinutes * 60 * 1000;
  },

  ByAuthorOrTime: (currentGroup, newChange, maxGapInMinutes) => {
    const authorMatch =
      !newChange.metadata?.author ||
      currentGroup.authorUrls.includes(
        newChange.metadata?.author as AutomergeUrl
      );
    const timeMatch =
      newChange.time === undefined ||
      newChange.time === 0 ||
      currentGroup.time === undefined ||
      currentGroup.time === 0 ||
      newChange.time < currentGroup.time + maxGapInMinutes * 60 * 1000;
    return authorMatch && timeMatch;
  },

  // Other groupings to try:
  // - time based sessions
  // - use a manual grouping persisted somewhere?
  // - nonlinear: group by actor, out of this sorted order of changes
};

export const GROUPINGS_THAT_TAKE_BATCH_SIZE: Array<keyof typeof GROUPINGS> = [
  "ByActorAndNumChanges",
  "ByNumberOfChanges",
  "ByCharCount",
];

export const GROUPINGS_THAT_TAKE_GAP_TIME: Array<keyof typeof GROUPINGS> = [
  "ByEditTime",
  "ByAuthorOrTime",
];

export const getMarkersForDoc = <
  DocType extends Branchable & Taggable & Discussable
>(
  handle: DocHandle<DocType>,
  repo: Repo
): HeadsMarker[] => {
  const doc = handle.docSync();
  if (!doc) return [];
  /** Mark tags aka milestones */
  let markers: HeadsMarker[] = (doc.tags ?? []).map((tag: Tag) => ({
    heads: tag.heads,
    type: "tag" as const,
    tag,
  }));

  /** Mark discussion threads */
  markers = markers.concat(
    // default value is there for compat with old docs
    Object.values(doc.discussions ?? {}).map((discussion) => ({
      heads: discussion.heads,
      type: "discussionThread",
      discussion,
    }))
  );

  /** Mark branch merge points */
  markers = markers.concat(
    doc.branchMetadata.branches
      .filter((branch) => branch.mergeMetadata !== undefined)
      .map((branch) => ({
        heads: branch.mergeMetadata!.mergeHeads,
        type: "otherBranchMergedIntoThisDoc",
        branch,
      }))
  );

  /** Mark branch start points */
  if (doc.branchMetadata.source) {
    const branchMetadataAtSource = repo
      .find<Branchable>(doc.branchMetadata.source.url)
      .docSync()
      .branchMetadata.branches.find((b) => b.url === handle.url);
    if (branchMetadataAtSource) {
      markers.push({
        heads: doc.branchMetadata.source.branchHeads,
        type: "originOfThisBranch",
        source: doc.branchMetadata.source,
        branch: branchMetadataAtSource,
        hideHistoryBeforeThis: true,
      });
    }
  }

  return markers;
};

// NOTE: this should be pushed down the stack as we formalize
// support for structured metadata on changes.
const getAllChangesWithMetadata = (doc: Doc<unknown>) => {
  return getAllChanges(doc).map((change) => {
    let decodedChange = decodeChange(change) as DecodedChangeWithMetadata;
    decodedChange.metadata = {};
    try {
      const metadata = JSON.parse(decodedChange.message);
      decodedChange = { ...decodedChange, metadata };
    } catch (e) {
      // do nothing for now...
    }
    return decodedChange;
  });
};

/* returns all the changes from this doc, grouped in a simple way for now. */
export const getGroupedChanges = (
  doc: Doc<MarkdownDoc>,
  {
    algorithm,
    numericParameter,
    markers,
  }: {
    /** The algorithm used to group changes (picking from presets defined in GROUPINGS) */
    algorithm: keyof typeof GROUPINGS;

    /** A numeric parameter used by some grouping algorithms for things like batch size.
     *  TODO: this should probably be more specifically named per grouping algo?
     */
    numericParameter: number;

    /** Markers to display at certain heads in the history */
    markers: HeadsMarker[];
  } = {
    algorithm: "ByActorAndNumChanges",
    /** Some algorithms have a numeric parameter like batch size that the user can control */
    numericParameter: 100,
    markers: [],
  }
) => {
  // TODO: we should sort this list in a stable way across devices.
  const changes = getAllChangesWithMetadata(doc);
  const changeGroups: ChangeGroup[] = [];

  let currentGroup: ChangeGroup | null = null;

  // define a helper for pushing a new group onto the list
  const pushGroup = (group: ChangeGroup) => {
    const diffHeads =
      changeGroups.length > 0 ? [changeGroups[changeGroups.length - 1].id] : [];
    group.diff = diffWithProvenance(doc, diffHeads, [group.id]);
    group.docAtEndOfChangeGroup = view(doc, [group.id]);

    const TEEChangeGroup = statsForChangeGroup(group);
    const groupWithStats = { ...group, ...TEEChangeGroup };

    if (!showChangeGroupInLog(groupWithStats)) {
      return;
    }
    changeGroups.push(groupWithStats);
  };

  // for each merged branch in the doc, we need to start a change group for that branch.
  // anytime we hit a change claimed by a merged branch, it's not considered in the regular
  // grouping logic, it's instead added to the single group for that branch.
  // then we add the branch's change group to the list once we hit its merge point.

  const branchChangeGroups: {
    [key: string]: {
      changeGroup: ChangeGroup;
      changeHashes: Set<Hash>;
      mergeMetadata: Branch["mergeMetadata"];
    };
  } = {};
  for (const branch of doc.branchMetadata.branches) {
    if (branch.mergeMetadata) {
      branchChangeGroups[branch.url] = {
        changeGroup: {
          id: branch.mergeMetadata.mergeHeads[0],
          changes: [],
          actorIds: [],
          authorUrls: [],
          docAtEndOfChangeGroup: undefined,
          diff: { patches: [], fromHeads: [], toHeads: [] },
          markers: [],
          time: undefined,
          charsAdded: 0,
          charsDeleted: 0,
          commentsAdded: 0,
          editCount: 0,
          headings: [],
        },
        changeHashes: getChangesFromMergedBranch({
          decodedChangesForDoc: changes,
          branchHeads: branch.mergeMetadata.mergeHeads,
          mainHeads: getHeads(doc),
          baseHeads: branch.branchHeads ?? [],
        }),
        mergeMetadata: branch.mergeMetadata,
      };
    }
  }

  // Now we loop over the changes and make our groups.
  for (let i = 0; i < changes.length; i++) {
    const decodedChange = changes[i];

    // If the change came from a merged branch, add it to the group for that branch,
    // don't include it in our raw grouping.
    let changeCameFromMergedBranch = false;
    for (const branchChangeGroup of Object.values(branchChangeGroups)) {
      if (branchChangeGroup.changeHashes.has(decodedChange.hash)) {
        // Now that we've hit changes from a branch, cut off the current group that was formed on main.
        // (TODO: maybe we should be looking out for "branch started" markers on the primary loop instead?)
        if (currentGroup) {
          pushGroup(currentGroup);
          currentGroup = null;
        }

        // we'll use this to break out of the main loop
        changeCameFromMergedBranch = true;
        branchChangeGroup.changeGroup.changes.push(decodedChange);

        // TODO: DRY the logic for updating these fields
        if (decodedChange.time && decodedChange.time > 0) {
          branchChangeGroup.changeGroup.time = decodedChange.time;
        }
        if (
          !branchChangeGroup.changeGroup.actorIds.includes(decodedChange.actor)
        ) {
          branchChangeGroup.changeGroup.actorIds.push(decodedChange.actor);
        }
        if (
          decodedChange.metadata?.author &&
          !branchChangeGroup.changeGroup.authorUrls.includes(
            decodedChange.metadata.author as AutomergeUrl
          )
        ) {
          branchChangeGroup.changeGroup.authorUrls.push(
            decodedChange.metadata.author as AutomergeUrl
          );
        }

        // If this is the change that was the last one for the branch
        // pre-merged, then it's time to add the change group for this branch
        // to our list of groups
        if (
          branchChangeGroup.mergeMetadata.mergeHeads.includes(
            decodedChange.hash
          )
        ) {
          const mergeMarker = markers.find(
            (marker) =>
              isEqual(
                marker.heads,
                branchChangeGroup.mergeMetadata.mergeHeads
              ) && marker.type === "otherBranchMergedIntoThisDoc"
          );
          if (mergeMarker) {
            branchChangeGroup.changeGroup.markers.push(mergeMarker);
          }

          // todo: what other finalizing do we need to do here..? any?
          pushGroup(branchChangeGroup.changeGroup);
        }

        continue;
      }
    }

    if (changeCameFromMergedBranch) {
      continue;
    }

    // Choose whether to add this change to the existing group or start a new group depending on the algorithm.
    if (
      currentGroup &&
      GROUPINGS[algorithm](currentGroup, decodedChange, numericParameter)
    ) {
      currentGroup.changes.push(decodedChange);
      currentGroup.id = decodedChange.hash;
      if (decodedChange.time && decodedChange.time > 0) {
        currentGroup.time = decodedChange.time;
      }
      if (!currentGroup.actorIds.includes(decodedChange.actor)) {
        currentGroup.actorIds.push(decodedChange.actor);
      }
      if (
        decodedChange.metadata?.author &&
        !currentGroup.authorUrls.includes(
          decodedChange.metadata.author as AutomergeUrl
        )
      ) {
        currentGroup.authorUrls.push(
          decodedChange.metadata.author as AutomergeUrl
        );
      }

      // If this change is tagged, then we should end the current group.
      // This ensures we have a group boundary corresponding to the tag in the changelog.
      // TODO: The comparison here seems a little iffy; we're comparing heads to a single change hash...
      // how should this actually work?
      const matchingMarkers = markers.filter(
        (marker) => marker.heads[0] === decodedChange.hash
      );
      if (matchingMarkers.length > 0) {
        currentGroup.markers = matchingMarkers;
        pushGroup(currentGroup);
        currentGroup = null;
      }
    } else {
      if (currentGroup) {
        pushGroup(currentGroup);
      }
      currentGroup = {
        // the "ID" is the hash of the latest change in the group.
        // TODO: revisit whether this makes sense as an identifier for the group?
        // It's a bit dangerous to store this separately from the changes since they
        // might get out of sync, but it's super convenient in the view...
        id: decodedChange.hash,
        changes: [decodedChange],
        actorIds: [decodedChange.actor],
        charsAdded: 0,
        charsDeleted: 0,
        commentsAdded: 0,
        diff: { patches: [], fromHeads: [], toHeads: [] },
        markers: [],
        time:
          decodedChange.time && decodedChange.time > 0
            ? decodedChange.time
            : undefined,
        authorUrls: decodedChange.metadata?.author
          ? [decodedChange.metadata.author as AutomergeUrl]
          : [],
        docAtEndOfChangeGroup: undefined, // We'll fill this in when we finalize the group
        headings: [],
        editCount: 0,
      };
    }
  }

  if (currentGroup) {
    pushGroup(currentGroup);
  }

  return { changeGroups, changeCount: changes.length };
};