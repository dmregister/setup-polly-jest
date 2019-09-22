/**
 * Flag, showing that Polly is active
 */
const IS_POLLY_ACTIVE = Symbol('IS_POLLY_ACTIVE');

/**
 * Flag, showing that proxy test methods are attached
 */
const IS_POLLY_ATTACHED = Symbol('IS_POLLY_ATTACHED');

/**
 * Shared context to keep polly instance and
 * options for a specific run
 */
const pollyContext = {
  polly: null,
  options: {}
};

/**
 * Get full spec description, starting from the top
 * suite
 *
 * @param {Object} spec Current spec
 * @param {Object} suite Current spec parent suite
 *
 * @returns {string} Full spec description (e.g. "suite/should do something")
 */
function getRecordingName(spec, suite) {
  const descriptions = [spec.description];

  while (suite) {
    suite.description && descriptions.push(suite.description);
    suite = suite.parentSuite;
  }

  return descriptions.reverse().join('/');
}

/**
 * Recursively go through suite and its children
 * and return the first that matches the findFn
 * condition
 *
 * @param {Object} suite Starting point
 * @param {Function} findFn Find function
 *
 * @returns {?Object} Matching suite or null
 */
function findSuiteRec(suite, findFn) {
  if (findFn(suite)) return suite;

  for (let i = 0, len = (suite.children || []).length; i < len; i++) {
    const child = suite.children[i];
    const result = findSuiteRec(child, findFn);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

/**
 * Create proxy for jasmine test function that starts and
 * stops Polly on before/after hooks
 *
 * @param {Object} Polly Polly constructor
 * @param {Function} fn Original test runner test function
 * @param {Object} jasmineEnv Jasmine environment
 *
 * @returns {Function} Proxy function
 */
function createTestFnProxy(Polly, fn, jasmineEnv) {
  return function testFn() {
    const spec = fn.apply(jasmineEnv, arguments);
    const specHooks = spec.beforeAndAfterFns;

    let pollyError;

    spec.beforeAndAfterFns = function beforeAndAfterFns() {
      const { befores, afters } = specHooks.apply(spec, arguments);

      const before = async function before(done) {
        try {
          if (jasmineEnv[IS_POLLY_ACTIVE]) {
            const topSuite = jasmineEnv.topSuite();
            const specParentSuite = findSuiteRec(topSuite, suite =>
              (suite.children || []).some(child => child.id === spec.id)
            );

            let recordingName = getRecordingName(spec, specParentSuite);

            // In jest top suite description is empty, in jasmine it is
            // randomly generated string. We don't want it to be used
            // as recording name if it exists
            if (topSuite.description) {
              recordingName = recordingName.replace(
                `${topSuite.description}/`,
                ''
              );
            }

            pollyContext.polly = new Polly(recordingName, pollyContext.options);
          }

          done && done();
        } catch (error) {
          // If we caught instance of the polly error, we will save it for the
          // reference and continue with the tests to print the error at the end
          // of the spec where it's more visible
          if (error.name === 'PollyError') {
            pollyError = error;
            done && done();
          } else if (done) {
            // Otherwise let's just fail spec/throw error, there is nothing
            // special we can do in that case
            done.fail(error);
          } else {
            throw error;
          }
        }
      };

      const after = async function after(done) {
        try {
          // We want to throw polly error here so it's shown as the last one in the
          // list of possible errors that happend during the test run
          if (pollyError) {
            pollyError.message =
              pollyError.message.replace(/\.$/, '') +
              ". Check `setupPolly` method and make sure it's configured correctly.";

            throw pollyError;
          }

          if (jasmineEnv[IS_POLLY_ACTIVE] && pollyContext.polly) {
            await pollyContext.polly.stop();
            pollyContext.polly = null;
          }

          done && done();
        } catch (error) {
          if (done) {
            done.fail(error);
          } else {
            throw error;
          }
        }
      };

      return {
        befores: [{ fn: before }, ...befores],
        afters: [...afters, { fn: after }]
      };
    };

    return spec;
  };
}

/**
 * Attach test fn proxies to jasmine environment if needed and
 * add beforeAll/afterAll hooks that will activate/deactivate
 * Polly when running test suite
 *
 * @param {Object} Polly Polly constructor
 * @param {Object} defaults Polly default options
 * @param {Object} ctx Global context
 *
 * @returns {Object} Context with `polly` property
 */
export default function setupJasmine(Polly, defaults = {}, ctx = global) {
  if (
    !ctx.jasmine ||
    (ctx.jasmine && typeof ctx.jasmine.getEnv !== 'function')
  ) {
    throw new TypeError(
      'Couldn\'t find jasmine environment. Make sure that you are using "setupJasmine" in ' +
        'jasmine/jest environment or that you provided proper jasmine environment when calling "setupJasmine"'
    );
  }

  const jasmineEnv = ctx.jasmine.getEnv();

  if (!jasmineEnv[IS_POLLY_ATTACHED]) {
    jasmineEnv.it = createTestFnProxy(Polly, jasmineEnv.it, jasmineEnv);
    jasmineEnv.fit = createTestFnProxy(Polly, jasmineEnv.fit, jasmineEnv);

    jasmineEnv[IS_POLLY_ATTACHED] = true;
    jasmineEnv[IS_POLLY_ACTIVE] = false;
  }

  ctx.beforeAll(() => {
    pollyContext.options = defaults;
    jasmineEnv[IS_POLLY_ACTIVE] = true;
  });

  ctx.afterAll(() => {
    pollyContext.options = null;
    jasmineEnv[IS_POLLY_ACTIVE] = false;
  });

  return {
    get polly() {
      return pollyContext.polly;
    }
  };
}

setupJasmine.IS_POLLY_ACTIVE = IS_POLLY_ACTIVE;

setupJasmine.IS_POLLY_ATTACHED = IS_POLLY_ATTACHED;
