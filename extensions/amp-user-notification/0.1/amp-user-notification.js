/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {all} from '../../../src/promise';
import {assertHttpsUrl, addParamsToUrl} from '../../../src/url';
import {assert} from '../../../src/asserts';
import {cidFor} from '../../../src/cid';
import {getService} from '../../../src/service';
import {log} from '../../../src/log';
import {storageFor} from '../../../src/storage';
import {urlReplacementsFor} from '../../../src/url-replacements';
import {viewerFor} from '../../../src/viewer';
import {whenDocumentReady} from '../../../src/document-state';
import {xhrFor} from '../../../src/xhr';


/**
 * @export
 * @typedef {{
 *   elementId: string,
 *   ampUserId: string
 * }}
 */
let PostRequestMetadataDef;

/**
 * @export
 * @typedef {{
 *   showNotification: boolean
 * }}
 */
let PostResponseMetadataDef;

/**
 * @typedef {{
 *   promise: !Promise,
 *   resolve: function(*)
 * }}
 */
let UserNotificationDeferDef;


/**
 * Defines underlying API for Notification components.
 * @interface
 */
class NotificationInterface {

  /**
   * Promise that is resolved with a boolean on whether this Notification
   * should be shown or not.
   * @return {!Promise<boolean>}
   */
  shouldShow() {}

  /**
   * Turns the Notification Component visible.
   * @return {!Promise}
   */
  show() {}
}

/**
 * Component class that handles a simple notification.
 * @implements {NotificationInterface}
 */
export class AmpUserNotification extends AMP.BaseElement {

  /** @override */
  createdCallback() {

    /** @private @const {!Window} */
    this.win_ = this.getWin();

    /** @private @const {!UrlReplacements} */
    this.urlReplacements_ = urlReplacementsFor(this.win_);

    /** @private @const {!UserNotificationManager} */
    this.userNotificationManager_ = getUserNotificationManager_(this.win_);

    /** @const @private {!Promise<!Storage>} */
    this.storagePromise_ = storageFor(this.win_);

    // TODO(dvoytenko, #1942): Cleanup `amp-storage` experiment.
    /** @const @private {boolean} */
    this.isStorageEnabled_ = true;
  }

  /** @override */
  buildCallback() {

    /** @private {?string} */
    this.ampUserId_ = null;

    /** @private {function} */
    this.dialogResolve_ = null;

    /** @private {!Promise} */
    this.dialogPromise_ = new Promise(resolve => {
      this.dialogResolve_ = resolve;
    });

    this.elementId_ = assert(this.element.id,
        'amp-user-notification should have an id.');

    // TODO(dvoytenko, #1942): Cleanup `amp-storage` experiment.
    /** @private @const {?string} */
    this.storageKey_ = this.isStorageEnabled_ ?
        'amp-user-notification:' + this.elementId_ : null;

    /** @private @const {?string} */
    this.showIfHref_ = this.element.getAttribute('data-show-if-href');
    if (this.showIfHref_) {
      assertHttpsUrl(this.showIfHref_, this.element);
    }

    /** @private @const {?string} */
    this.dismissHref_ = this.element.getAttribute('data-dismiss-href');
    if (this.dismissHref_) {
      assertHttpsUrl(this.dismissHref_, this.element);
    }

    // TODO(dvoytenko): document storage behavior in these methods once
    // experiment is removed.
    if (!this.storageKey_) {
      assert(this.showIfHref_,
          `"amp-user-notification" (${this.elementId_}) ` +
          'should have "data-show-if-href" attribute.');
      assert(this.dismissHref_,
          `"amp-user-notification" (${this.elementId_}) ` +
          'should have "data-dismiss-href" attribute.');
    }

    this.userNotificationManager_
        .registerUserNotification(this.elementId_, this);

    this.registerAction('dismiss', this.dismiss.bind(this));
  }

  /**
   * Constructs the new href to execute a `GET` request with the
   * `elementId` and `ampUserId` query params appended.
   * @param {string} ampUserId
   * @return {!Promise<string>}
   * @private
   */
  buildGetHref_(ampUserId) {
    return this.urlReplacements_.expand(assert(this.showIfHref_)).then(href => {
      return addParamsToUrl(href, {
        elementId: this.elementId_,
        ampUserId: ampUserId
      });
    });
  }

  /**
   * Executes a `POST` request to the url given on the `data-show-if-href`
   * attribute.
   * @param {string} ampUserId
   * @return {!Promise<!PostResponseMetadataDef>}
   * @private
   */
  getShowEndpoint_(ampUserId) {
    this.ampUserId_ = ampUserId;
    return this.buildGetHref_(ampUserId).then(href => {
      const getReq = {
        credentials: 'include'
      };
      return xhrFor(this.win_).fetchJson(href, getReq);
    });
  }

  /**
   * Creates an POST to the specified `data-dismiss-href` url.
   * @private
   * @return {!Promise}
   */
  postDismissEnpoint_() {
    return xhrFor(this.win_).fetchJson(assert(this.dismissHref_), {
      method: 'POST',
      credentials: 'include',
      body: {
        'elementId': this.elementId_,
        'ampUserId': this.ampUserId_
      }
    });
  }

  /**
   * Success handler for `getShowEndpoint_`.
   * @param {!PostResponseMetadataDef}
   * @return {!Promise<boolean>}
   * @private
   */
  onGetShowEndpointSuccess_(data) {
    assert(typeof data['showNotification'] == 'boolean', '`showNotification` ' +
        'should be a boolean. Got "%s" which is of type %s.',
        data['showNotification'], typeof data['showNotification']);

    if (!data['showNotification']) {
      // If no notification needs to be shown, resolve the `dialogPromise_`
      // right away with false.
      this.dialogResolve_();
    }
    return Promise.resolve(data['showNotification']);
  }

  /**
   * Get async cid service.
   * @return {!Promise}
   * @private
   */
  getAsyncCid_() {
    return cidFor(this.win_).then(cid => {
      // `amp-user-notification` is our cid scope, while we give it a resolved
      // promise for the 2nd argument so that the 3rd argument (the
      // persistentConsent) is the one used to resolve getting
      // the external CID.
      // The dialogPromise_ is never rejected,
      // the user only really has 1 option to accept/dismiss (to resolve)
      // the notification or have the nagging notification sitting there
      // (to never resolve).
      return cid.get(
        {scope: 'amp-user-notification', createCookieIfNotPresent: true},
        Promise.resolve(), this.dialogPromise_);
    });
  }

  /** @override */
  shouldShow() {
    if (this.storageKey_) {
      return this.storagePromise_.then(storage => {
        return storage.get(this.storageKey_);
      }).then(value => {
        if (value) {
          // Consent has been accepted. Nothing more to do.
          return false;
        }
        if (this.showIfHref_) {
          // Ask remote endpoint if available.
          return this.shouldShowViaXhr_();
        }
        // Otherwise, show the notification.
        return true;
      }).catch(reason => {
        log.error('Failed to read storage', reason);
        if (this.showIfHref_) {
          return this.shouldShowViaXhr_();
        }
        return true;
      });
    }
    return this.shouldShowViaXhr_();
  }

  /**
   * @return {!Promise<boolean>}
   * @private
   */
  shouldShowViaXhr_() {
    return this.getAsyncCid_()
        .then(this.getShowEndpoint_.bind(this))
        .then(this.onGetShowEndpointSuccess_.bind(this));
  }

  /** @override */
  show() {
    this.element.style.display = '';
    this.element.classList.add('amp-active');
    return this.dialogPromise_;
  }

  /**
   * Hides the current user notification and invokes the `dialogResolve_`
   * method. Removes the `.amp-active` class from the element.
   */
  dismiss() {
    this.element.classList.remove('amp-active');
    this.element.classList.add('amp-hidden');
    this.dialogResolve_();

    // Store and post.
    if (this.storageKey_) {
      this.storagePromise_.then(storage => {
        storage.set(this.storageKey_, true);
      });
    }
    if (this.dismissHref_) {
      this.postDismissEnpoint_();
    }
  }
}


/**
 * UserNotificationManager handles `amp-user-notification`
 * queuing and registration, as well as exposing the components
 * dismiss promise.
 */
export class UserNotificationManager {

  constructor(window) {
    this.win_ = window;

    /** @private @const {!Object<!UserNotificationDeferDef>} */
    this.deferRegistry_ = Object.create(null);

    /** @private @const {!Viewer} */
    this.viewer_ = viewerFor(this.win_);

    /** @private {!Promise} */
    this.managerReadyPromise_ = all([
      this.viewer_.whenFirstVisible(),
      whenDocumentReady(this.win_.document)
    ]);

    /** @private {!Promise} */
    this.nextInQueue_ = this.managerReadyPromise_;
  }

  /**
   * Retrieve a promise associated to an `amp-user-notification` component
   * that is resolved when user agrees to the terms.
   * @param {string} id
   * @return {!Promise}
   */
  get(id) {
    this.managerReadyPromise_.then(() => {
      if (this.win_.document.getElementById(id) == null) {
        console./*OK*/warn(`Did not find amp-user-notification element ${id}.`);
      }
    });
    return this.getElementDeferById_(id).promise;
  }

  /**
   * Register an instance of `amp-user-notification`.
   * @param {string} id
   * @param {!UserNotification} userNotification
   * @return {!Promise}
   * @package
   */
  registerUserNotification(id, userNotification) {
    const deferred = this.getElementDeferById_(id);

    // Compose the registered notifications into a promise queue
    // that blocks until one notification is dismissed.
    return this.nextInQueue_ = this.nextInQueue_
        .then(() => {
          return userNotification.shouldShow().then(shouldShow => {
            if (shouldShow) {
              return userNotification.show();
            }
          });
        })
        .then(deferred.resolve)
        .catch(this.onRejection_.bind(this, id));
  }

  onRejection_(id, err) {
    log.error('Notification service failed amp-user-notification', id, err);
  }

  /**
   * Retrieve UserNotificationDeferDef object.
   * @param {string} id
   * @return {!UserNotificationDeferDef}
   * @private
   */
  getElementDeferById_(id) {
    return this.createOrReturnDefer_(id);
  }

  /**
   * Create an defer if it doesnt exist, else just return the one in the
   * registry.
   * @return {!UserNotificationDeferDef}
   */
  createOrReturnDefer_(id) {
    if (this.deferRegistry_[id]) {
      return this.deferRegistry_[id];
    }

    let resolve;
    const promise = new Promise(r => {
      resolve = r;
    });

    return this.deferRegistry_[id] = {
      promise: promise,
      resolve: resolve
    };
  }
}

/**
 * @param {!Window} window
 * @return {!UserNotificationManager}
 * @private
 */
function getUserNotificationManager_(window) {
  return getService(window, 'userNotificationManager', () => {
    return new UserNotificationManager(window);
  });
}

/**
 * @param {!Window} window
 * @return {!UserNotificationManager}
 * @private
 */
export function installUserNotificationManager(window) {
  return getUserNotificationManager_(window);
}

installUserNotificationManager(AMP.win);

AMP.registerElement('amp-user-notification', AmpUserNotification, $CSS$);
