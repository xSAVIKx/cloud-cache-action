export const id = 699;
export const ids = [699];
export const modules = {

/***/ 5080:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   existsInGitHub: () => (/* binding */ existsInGitHub),
/* harmony export */   restoreFromGitHub: () => (/* binding */ restoreFromGitHub),
/* harmony export */   saveToGitHub: () => (/* binding */ saveToGitHub)
/* harmony export */ });
/* harmony import */ var _actions_cache__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(6080);
/* harmony import */ var _utils_inputUtils__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(632);
/* harmony import */ var _cacheMode__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(8742);
/* harmony import */ var _outcomes__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(9570);




/**
 * The error for a run without the GitHub Actions cache service, or undefined when the service is
 * available. Without the service, @actions/cache retries each call for about 10 s and then fails.
 * A save also makes a second archive and leaves a temp directory. So each call checks first.
 */
function unavailable() {
    const problem = (0,_cacheMode__WEBPACK_IMPORTED_MODULE_2__/* .gitHubCacheServiceProblem */ .My)();
    return problem === undefined ? undefined : new _cacheMode__WEBPACK_IMPORTED_MODULE_2__/* .GitHubCacheUnavailableError */ .oH(problem);
}
async function restoreFromGitHub(paths, primaryKey, restoreKeys, lookupOnly, enableCrossOsArchive) {
    const error = unavailable();
    if (error) {
        return { kind: 'error', error };
    }
    try {
        const matchedKey = await _actions_cache__WEBPACK_IMPORTED_MODULE_0__/* .restoreCache */ .P3([...paths], primaryKey, [...restoreKeys], { lookupOnly }, enableCrossOsArchive);
        if (!matchedKey) {
            return { kind: 'miss' };
        }
        return { kind: 'hit', matchedKey, exact: (0,_utils_inputUtils__WEBPACK_IMPORTED_MODULE_1__/* .isExactKeyMatch */ .of)(primaryKey, matchedKey) };
    }
    catch (err) {
        return { kind: 'error', error: (0,_outcomes__WEBPACK_IMPORTED_MODULE_3__/* .toError */ .i)(err) };
    }
}
/**
 * Whether GitHub Actions Cache already holds exactly `key`. A lookup also returns prefix
 * matches, which do not count. It throws a GitHubCacheUnavailableError when the service is not
 * available, so callers can apply strict mode. @actions/cache handles most other service failures
 * itself and reports a miss.
 */
async function existsInGitHub(paths, key, enableCrossOsArchive) {
    const error = unavailable();
    if (error) {
        throw error;
    }
    const matchedKey = await _actions_cache__WEBPACK_IMPORTED_MODULE_0__/* .restoreCache */ .P3([...paths], key, [], { lookupOnly: true }, enableCrossOsArchive);
    return (0,_utils_inputUtils__WEBPACK_IMPORTED_MODULE_1__/* .isExactKeyMatch */ .of)(key, matchedKey);
}
async function saveToGitHub(paths, key, uploadChunkSize, enableCrossOsArchive) {
    const error = unavailable();
    if (error) {
        return { kind: 'error', error };
    }
    try {
        const cacheId = await _actions_cache__WEBPACK_IMPORTED_MODULE_0__/* .saveCache */ .Io([...paths], key, { uploadChunkSize }, enableCrossOsArchive);
        // -1 means @actions/cache did not save and already logged why: another job is creating
        // the entry, the cache mode forbids writes, or it swallowed a service error itself.
        if (cacheId === -1) {
            return {
                kind: 'skipped',
                reason: 'GitHub Actions Cache did not save this key (see the messages above)',
            };
        }
        return { kind: 'saved' };
    }
    catch (err) {
        // @actions/cache throws a ValidationError when the path list is empty. It throws a plain
        // Error, with the same message prefix, when no path exists. Match the prefix for both.
        if (err instanceof Error && err.message.startsWith('Path Validation Error')) {
            return { kind: 'skipped', reason: 'no paths matched' };
        }
        return { kind: 'error', error: (0,_outcomes__WEBPACK_IMPORTED_MODULE_3__/* .toError */ .i)(err) };
    }
}


/***/ })

};
