/**
 * The comment feed's wire contract, owned by the server package: the routes
 * and the UI move together or the build breaks.
 */

import type { FactoryMentionRef, WorkItemCommentReplyRef } from '@factory/store/comments/base';
import type { WireComment, WireCommentAuthor, WireCommentPage } from '@factory/feed/comments/wire';

export type WorkItemComment = WireComment;
export type WorkItemCommentPage = WireCommentPage;
export type CommentAuthor = WireCommentAuthor;
export type CommentMentionRef = FactoryMentionRef;
export type CommentReplyRef = WorkItemCommentReplyRef;
