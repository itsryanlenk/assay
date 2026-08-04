/**
 * The outbound interface. No implementation yet, and that is the point.
 *
 * This file exists so Law 3 is enforced by the type system before any sender
 * is written, rather than after. Every outbound function takes an
 * `ApprovedItem`, which only `approval/gate.ts` can mint, so the failure mode
 * "somebody added a send path and forgot the gate" is a compile error rather
 * than a code review catch.
 *
 * Writing the interface first is deliberate. The alternative is to add it
 * alongside the first provider, by which time the natural signature is
 * `send(filename)` and the gate becomes an extra step somebody remembers.
 */

import { ApprovedItem } from '../approval/gate';

export type PostcardAddress = {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
};

export type SendReceipt = {
  providerId: string;
  providerRef: string;
  sentAt: string;
  costUsd?: number;
};

export interface PostcardProvider {
  readonly id: 'lob' | 'postgrid';
  probe(): Promise<{ available: boolean; detail: string }>;
  /**
   * The first parameter is the whole enforcement. An id, a filename or a path
   * would all make an unapproved send merely a mistake; an ApprovedItem makes
   * it uncompilable, because the token's brand is a symbol this module cannot
   * see and no caller can construct.
   */
  send(item: ApprovedItem, to: PostcardAddress, from: PostcardAddress): Promise<SendReceipt>;
}
