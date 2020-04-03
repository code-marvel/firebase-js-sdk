/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { User } from '../auth/user';
import { Document, MaybeDocument } from '../model/document';
import { DocumentKey } from '../model/document_key';
import { assert, fail } from '../util/assert';
import { Code, FirestoreError } from '../util/error';
import { logDebug } from '../util/log';
import { ObjectMap } from '../util/obj_map';
import { encodeResourcePath } from './encoded_resource_path';
import {
  ActiveTargets,
  LruDelegate,
  LruGarbageCollector,
  LruParams
} from './lru_garbage_collector';
import { DatabaseInfo } from '../core/database_info';
import { PersistenceSettings } from '../core/firestore_client';
import { ListenSequence } from '../core/listen_sequence';
import { ListenSequenceNumber } from '../core/types';
import { estimateByteSize } from '../model/values';
import { AsyncQueue } from '../util/async_queue';
import { MemoryIndexManager } from './memory_index_manager';
import { MemoryMutationQueue } from './memory_mutation_queue';
import { MemoryRemoteDocumentCache } from './memory_remote_document_cache';
import { MemoryTargetCache } from './memory_target_cache';
import { MutationQueue } from './mutation_queue';
import {
  GarbageCollectionScheduler,
  Persistence,
  PersistenceProvider,
  PersistenceTransaction,
  PersistenceTransactionMode,
  PrimaryStateListener,
  ReferenceDelegate
} from './persistence';
import { PersistencePromise } from './persistence_promise';
import { Platform } from '../platform/platform';
import { ReferenceSet } from './reference_set';
import {
  ClientId,
  MemorySharedClientState,
  SharedClientState
} from './shared_client_state';
import { TargetData } from './target_data';
import { SyncEngine } from '../core/sync_engine';
import { LocalStore } from './local_store';
import { RemoteStore } from '../remote/remote_store';
import {IndexFreeQueryEngine} from "./index_free_query_engine";

const LOG_TAG = 'MemoryPersistence';

const MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE =
  'You are using the memory-only build of Firestore. Persistence support is ' +
  'only available via the @firebase/firestore bundle or the ' +
  'firebase-firestore.js build.';

/**
 * A memory-backed instance of Persistence. Data is stored only in RAM and
 * not persisted across sessions.
 */
export class MemoryPersistence implements Persistence {
  /**
   * Note that these are retained here to make it easier to write tests
   * affecting both the in-memory and IndexedDB-backed persistence layers. Tests
   * can create a new LocalStore wrapping this Persistence instance and this
   * will make the in-memory persistence layer behave as if it were actually
   * persisting values.
   */
  private readonly indexManager: MemoryIndexManager;
  private mutationQueues: { [user: string]: MemoryMutationQueue } = {};
  private readonly remoteDocumentCache: MemoryRemoteDocumentCache;
  private readonly targetCache: MemoryTargetCache;
  private readonly listenSequence = new ListenSequence(0);

  private _started = false;

  readonly referenceDelegate: MemoryReferenceDelegate;

  /**
   * The constructor accepts a factory for creating a reference delegate. This
   * allows both the delegate and this instance to have strong references to
   * each other without having nullable fields that would then need to be
   * checked or asserted on every access.
   */
  constructor(
    referenceDelegateFactory: (p: MemoryPersistence) => MemoryReferenceDelegate
  ) {
    this._started = true;
    this.referenceDelegate = referenceDelegateFactory(this);
    this.targetCache = new MemoryTargetCache(this);
    const sizer = (doc: MaybeDocument): number =>
      this.referenceDelegate.documentSize(doc);
    this.indexManager = new MemoryIndexManager();
    this.remoteDocumentCache = new MemoryRemoteDocumentCache(
      this.indexManager,
      sizer
    );
  }

  shutdown(): Promise<void> {
    // No durable state to ensure is closed on shutdown.
    this._started = false;
    return Promise.resolve();
  }

  get started(): boolean {
    return this._started;
  }

  setDatabaseDeletedListener(): void {
    // No op.
  }
  
  getIndexManager(): MemoryIndexManager {
    return this.indexManager;
  }

  getMutationQueue(user: User): MutationQueue {
    let queue = this.mutationQueues[user.toKey()];
    if (!queue) {
      queue = new MemoryMutationQueue(
        this.indexManager,
        this.referenceDelegate
      );
      this.mutationQueues[user.toKey()] = queue;
    }
    return queue;
  }

  getTargetCache(): MemoryTargetCache {
    return this.targetCache;
  }

  getRemoteDocumentCache(): MemoryRemoteDocumentCache {
    return this.remoteDocumentCache;
  }

  runTransaction<T>(
    action: string,
    mode: PersistenceTransactionMode,
    transactionOperation: (
      transaction: PersistenceTransaction
    ) => PersistencePromise<T>
  ): Promise<T> {
    logDebug(LOG_TAG, 'Starting transaction:', action);
    const txn = new MemoryTransaction(this.listenSequence.next());
    this.referenceDelegate.onTransactionStarted();
    return transactionOperation(txn)
      .next(result => {
        return this.referenceDelegate
          .onTransactionCommitted(txn)
          .next(() => result);
      })
      .toPromise()
      .then(result => {
        txn.raiseOnCommittedEvent();
        return result;
      });
  }

  mutationQueuesContainKey(
    transaction: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<boolean> {
    return PersistencePromise.or(
      Object.values(this.mutationQueues).map(queue => () =>
        queue.containsKey(transaction, key)
      )
    );
  }
}

/**
 * Memory persistence is not actually transactional, but future implementations
 * may have transaction-scoped state.
 */
export class MemoryTransaction extends PersistenceTransaction {
  constructor(readonly currentSequenceNumber: ListenSequenceNumber) {
    super();
  }
}

export interface MemoryReferenceDelegate extends ReferenceDelegate {
  documentSize(doc: MaybeDocument): number;
  onTransactionStarted(): void;
  onTransactionCommitted(txn: PersistenceTransaction): PersistencePromise<void>;
}

export class MemoryEagerDelegate implements MemoryReferenceDelegate {
  private inMemoryPins: ReferenceSet | null = null;
  private _orphanedDocuments: Set<DocumentKey> | null = null;

  constructor(private readonly persistence: MemoryPersistence) {}

  private get orphanedDocuments(): Set<DocumentKey> {
    if (!this._orphanedDocuments) {
      throw fail('orphanedDocuments is only valid during a transaction.');
    } else {
      return this._orphanedDocuments;
    }
  }

  setInMemoryPins(inMemoryPins: ReferenceSet): void {
    this.inMemoryPins = inMemoryPins;
  }

  addReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedDocuments.delete(key);
    return PersistencePromise.resolve();
  }

  removeReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedDocuments.add(key);
    return PersistencePromise.resolve();
  }

  removeMutationReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedDocuments.add(key);
    return PersistencePromise.resolve();
  }

  removeTarget(
    txn: PersistenceTransaction,
    targetData: TargetData
  ): PersistencePromise<void> {
    const cache = this.persistence.getTargetCache();
    return cache
      .getMatchingKeysForTargetId(txn, targetData.targetId)
      .next(keys => {
        keys.forEach(key => this.orphanedDocuments.add(key));
      })
      .next(() => cache.removeTargetData(txn, targetData));
  }

  onTransactionStarted(): void {
    this._orphanedDocuments = new Set<DocumentKey>();
  }

  onTransactionCommitted(
    txn: PersistenceTransaction
  ): PersistencePromise<void> {
    // Remove newly orphaned documents.
    const cache = this.persistence.getRemoteDocumentCache();
    const changeBuffer = cache.newChangeBuffer();
    return PersistencePromise.forEach(
      this.orphanedDocuments,
      (key: DocumentKey) => {
        return this.isReferenced(txn, key).next(isReferenced => {
          if (!isReferenced) {
            changeBuffer.removeEntry(key);
          }
        });
      }
    ).next(() => {
      this._orphanedDocuments = null;
      return changeBuffer.apply(txn);
    });
  }

  updateLimboDocument(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    return this.isReferenced(txn, key).next(isReferenced => {
      if (isReferenced) {
        this.orphanedDocuments.delete(key);
      } else {
        this.orphanedDocuments.add(key);
      }
    });
  }

  documentSize(doc: MaybeDocument): number {
    // For eager GC, we don't care about the document size, there are no size thresholds.
    return 0;
  }

  private isReferenced(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<boolean> {
    return PersistencePromise.or([
      () => this.persistence.getTargetCache().containsKey(txn, key),
      () => this.persistence.mutationQueuesContainKey(txn, key),
      () => PersistencePromise.resolve(this.inMemoryPins!.containsKey(key))
    ]);
  }
}

export class MemoryLruDelegate implements ReferenceDelegate, LruDelegate {
  private inMemoryPins: ReferenceSet | null = null;
  private orphanedSequenceNumbers: ObjectMap<
    DocumentKey,
    ListenSequenceNumber
  > = new ObjectMap(k => encodeResourcePath(k.path));

  readonly garbageCollector: LruGarbageCollector;

  constructor(
    private readonly persistence: MemoryPersistence,
    lruParams: LruParams
  ) {
    this.garbageCollector = new LruGarbageCollector(this, lruParams);
  }

  // No-ops, present so memory persistence doesn't have to care which delegate
  // it has.
  onTransactionStarted(): void {}

  onTransactionCommitted(
    txn: PersistenceTransaction
  ): PersistencePromise<void> {
    return PersistencePromise.resolve();
  }

  forEachTarget(
    txn: PersistenceTransaction,
    f: (q: TargetData) => void
  ): PersistencePromise<void> {
    return this.persistence.getTargetCache().forEachTarget(txn, f);
  }

  getSequenceNumberCount(
    txn: PersistenceTransaction
  ): PersistencePromise<number> {
    const docCountPromise = this.orphanedDocumentCount(txn);
    const targetCountPromise = this.persistence
      .getTargetCache()
      .getTargetCount(txn);
    return targetCountPromise.next(targetCount =>
      docCountPromise.next(docCount => targetCount + docCount)
    );
  }

  private orphanedDocumentCount(
    txn: PersistenceTransaction
  ): PersistencePromise<number> {
    let orphanedCount = 0;
    return this.forEachOrphanedDocumentSequenceNumber(txn, _ => {
      orphanedCount++;
    }).next(() => orphanedCount);
  }

  forEachOrphanedDocumentSequenceNumber(
    txn: PersistenceTransaction,
    f: (sequenceNumber: ListenSequenceNumber) => void
  ): PersistencePromise<void> {
    return PersistencePromise.forEach(
      this.orphanedSequenceNumbers,
      (key, sequenceNumber) => {
        // Pass in the exact sequence number as the upper bound so we know it won't be pinned by
        // being too recent.
        return this.isPinned(txn, key, sequenceNumber).next(isPinned => {
          if (!isPinned) {
            return f(sequenceNumber);
          } else {
            return PersistencePromise.resolve();
          }
        });
      }
    );
  }

  setInMemoryPins(inMemoryPins: ReferenceSet): void {
    this.inMemoryPins = inMemoryPins;
  }

  removeTargets(
    txn: PersistenceTransaction,
    upperBound: ListenSequenceNumber,
    activeTargetIds: ActiveTargets
  ): PersistencePromise<number> {
    return this.persistence
      .getTargetCache()
      .removeTargets(txn, upperBound, activeTargetIds);
  }

  removeOrphanedDocuments(
    txn: PersistenceTransaction,
    upperBound: ListenSequenceNumber
  ): PersistencePromise<number> {
    let count = 0;
    const cache = this.persistence.getRemoteDocumentCache();
    const changeBuffer = cache.newChangeBuffer();
    const p = cache.forEachDocumentKey(txn, key => {
      return this.isPinned(txn, key, upperBound).next(isPinned => {
        if (!isPinned) {
          count++;
          changeBuffer.removeEntry(key);
        }
      });
    });
    return p.next(() => changeBuffer.apply(txn)).next(() => count);
  }

  removeMutationReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedSequenceNumbers.set(key, txn.currentSequenceNumber);
    return PersistencePromise.resolve();
  }

  removeTarget(
    txn: PersistenceTransaction,
    targetData: TargetData
  ): PersistencePromise<void> {
    const updated = targetData.withSequenceNumber(txn.currentSequenceNumber);
    return this.persistence.getTargetCache().updateTargetData(txn, updated);
  }

  addReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedSequenceNumbers.set(key, txn.currentSequenceNumber);
    return PersistencePromise.resolve();
  }

  removeReference(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedSequenceNumbers.set(key, txn.currentSequenceNumber);
    return PersistencePromise.resolve();
  }

  updateLimboDocument(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<void> {
    this.orphanedSequenceNumbers.set(key, txn.currentSequenceNumber);
    return PersistencePromise.resolve();
  }

  documentSize(maybeDoc: MaybeDocument): number {
    let documentSize = maybeDoc.key.toString().length;
    if (maybeDoc instanceof Document) {
      documentSize += estimateByteSize(maybeDoc.toProto());
    }
    return documentSize;
  }

  private isPinned(
    txn: PersistenceTransaction,
    key: DocumentKey,
    upperBound: ListenSequenceNumber
  ): PersistencePromise<boolean> {
    return PersistencePromise.or([
      () => this.persistence.mutationQueuesContainKey(txn, key),
      () => PersistencePromise.resolve(this.inMemoryPins!.containsKey(key)),
      () => this.persistence.getTargetCache().containsKey(txn, key),
      () => {
        const orphanedAt = this.orphanedSequenceNumbers.get(key);
        return PersistencePromise.resolve(
          orphanedAt !== undefined && orphanedAt > upperBound
        );
      }
    ]);
  }

  getCacheSize(txn: PersistenceTransaction): PersistencePromise<number> {
    return this.persistence.getRemoteDocumentCache().getSize(txn);
  }
}

export class MemoryPersistenceProvider implements PersistenceProvider {
  private clientId!: ClientId;
  private localStore!: LocalStore;
  private persistence!: MemoryPersistence;
  private syncEngine!: SyncEngine;
  private sharedClientState!: MemorySharedClientState;

  initialize(
    asyncQueue: AsyncQueue,
    remoteStore: RemoteStore,
    databaseInfo: DatabaseInfo,
    platform: Platform,
    clientId: ClientId,
    initialUser: User,
    maxConcurrentLimboResolutions: number,
    settings: PersistenceSettings
  ): Promise<void> {
    if (settings.durable) {
      throw new FirestoreError(
        Code.FAILED_PRECONDITION,
        MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE
      );
    }
    this.clientId = clientId;
    this.persistence = new MemoryPersistence(
      p => new MemoryEagerDelegate(p)
    );
    this.sharedClientState = new MemorySharedClientState();
    this.localStore = new LocalStore(this.persistence, new IndexFreeQueryEngine(), initialUser);
    this.syncEngine = new SyncEngine(
      this.localStore,
      remoteStore,
      this.sharedClientState ,
      initialUser,
      maxConcurrentLimboResolutions
    );
    remoteStore.syncEngine = this.syncEngine;
    return Promise.resolve();
  }

  getGarbageCollectionScheduler(): GarbageCollectionScheduler {
    let started = false;
    return {
      started,
      start: () => (started = true),
      stop: () => (started = false)
    };
  }

  getPersistence(): Persistence {
    assert(!!this.persistence, 'initialize() not called');
    return this.persistence;
  }

  getSharedClientState(): SharedClientState {
    assert(!!this.sharedClientState, 'initialize() not called');
    return this.sharedClientState;
  }

  getLocalStore(): LocalStore {
    assert(!!this.localStore, 'initialize() not called');
    return this.localStore;
  }

  getSyncEngine(): SyncEngine {
    assert(!!this.syncEngine, 'initialize() not called');
    return this.syncEngine;
  }

  clearPersistence(): never {
    throw new FirestoreError(
      Code.FAILED_PRECONDITION,
      MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE
    );
  }
}
