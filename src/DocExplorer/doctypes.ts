import { next as A } from "@automerge/automerge";
import { AutomergeUrl } from "@automerge/automerge-repo";
import { TLDrawDatatype } from "@/tldraw/datatype";
import { DataGridDatatype } from "@/datagrid/datatype";
import { EssayDatatype } from "@/tee/datatype";
import { EssayEditingBotDatatype } from "@/bots/datatype";
import { Repo } from "@automerge/automerge-repo";
import { DecodedChangeWithMetadata } from "@/patchwork/groupChanges";
import { HasPatchworkMetadata } from "@/patchwork/schema";
import { TextPatch } from "@/patchwork/utils";
import { Annotation, AnnotationPosition } from "@/patchwork/schema";

export interface DataType<D, T, V> {
  id: string;
  name: string;
  icon: any;
  init: (doc: D, repo: Repo) => void;
  getTitle: (doc: D, repo: Repo) => Promise<string>;
  markCopy: (doc: D) => void; // TODO: this shouldn't be part of the interface

  // version related functions
  includeChangeInHistory?: (
    doc: D,
    change: DecodedChangeWithMetadata
  ) => boolean;
  includePatchInChangeGroup?: (patch: A.Patch | TextPatch) => boolean; // todo: can we get rid of TextPatch here?

  promptForAutoChangeGroupDescription?: (args: {
    docBefore: D;
    docAfter: D;
  }) => string;

  patchesToAnnotations?: (doc: D, patches: A.Patch[]) => Annotation<T, V>[];
}

export const docTypes: Record<
  string,
  DataType<HasPatchworkMetadata, unknown, unknown>
> = {
  essay: EssayDatatype,
  tldraw: TLDrawDatatype,
  datagrid: DataGridDatatype,
  bot: EssayEditingBotDatatype,
} as const;

export type DocType = keyof typeof docTypes;

export interface DocEditorProps<T, V> {
  docUrl: AutomergeUrl;
  docHeads?: A.Heads;
  activeDiscussionIds?: string[];
  annotations?: Annotation<T, V>[];
  actorIdToAuthor?: Record<A.ActorId, AutomergeUrl>; // todo: can we replace that with memoize?

  // spatial comments interface
  // todo: simplify
  selectedAnnotations?: Annotation<T, V>;
  hoveredAnnotation?: Annotation<T, V>;
  setHoveredAnnotation?: (annotation: Annotation<T, V>) => void;
  setSelectedAnnotations?: (annotations: Annotation<T, V>[]) => void;
  onUpdateAnnotationsPositions?: (
    positions: AnnotationPosition<T, V>[]
  ) => void;
}
