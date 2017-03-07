import Boom from 'boom';
import Joi from 'joi';
import { createRoutes } from './baseRoutes';
import Bluebird from 'bluebird';
import mergeOptions from 'merge-options';

const baseRoutes = createRoutes();

function plugin(server, _, next) {
  server.route(
    this.constructor.routes
    .map((method) => this.route(method, baseRoutes[method]))
    .reduce((acc, curr) => acc.concat(curr), []) // routeRelationship returns an array
  );
  server.route(this.extraRoutes());
  next();
}

export class BaseController {
  constructor(plump, Model, options = {}) {
    this.plump = plump;
    this.Model = Model;
    this.options = Object.assign({}, { sideloads: [] }, options);
    this.plugin = plugin.bind(this);
    this.plugin.attributes = Object.assign({}, {
      version: '1.0.0',
      name: this.Model.$name,
    }, this.options.plugin);
  }

  extraRoutes() {
    return [];
  }

  read() {
    return (request) => {
      return request.pre.item.$get()
      .then((obj) => {
        return Bluebird.all(this.options.sideloads.map((field) => request.pre.item.$get(field)))
        .then((values) => {
          const sides = {};
          values.forEach((v, idx) => {
            sides[this.options.sideloads[idx]] = v;
          });
          return Object.assign({}, obj, sides);
        });
      }).then((resp) => {
        return {
          [this.Model.$name]: [resp],
        };
      });
    };
  }


  update() {
    return (request) => {
      return request.pre.item.$set(request.payload).$save()
      .then((v) => {
        return v.$get();
      });
    };
  }

  delete() {
    return (request) => {
      return request.pre.item.$delete();
    };
  }

  create() {
    return (request) => {
      return new this.Model(request.payload, this.plump)
      .$save()
      .then((v) => {
        return v.$get();
      });
    };
  }

  addChild({ field }) {
    return (request) => {
      return request.pre.item.$add(field, request.payload).$save();
    };
  }

  listChildren({ field }) {
    return (request) => {
      return request.pre.item.$get(field)
      .then((list) => {
        return { [field]: list };
      });
    };
  }

  removeChild({ field }) {
    return (request) => {
      return request.pre.item.$remove(field, request.params.childId).$save();
    };
  }

  modifyChild({ field }) {
    return (request) => {
      return request.pre.item.$modifyRelationship(field, request.params.childId, request.payload).$save();
    };
  }

  query() {
    return (request) => {
      return this.plump.query(this.Model.$name, request.query);
    };
  }

  schema() {
    return () => {
      return Bluebird.resolve({
        schema: JSON.parse(JSON.stringify(this.Model)),
      });
    };
  }

  createHandler(method, options) {
    const handler = this[method](options);
    return (request, reply) => {
      return handler(request)
      .then((response) => {
        reply(response).code(200);
      }).catch((err) => {
        console.log(err);
        reply(Boom.badImplementation(err));
      });
    };
  }

  createJoiValidator(field) {
    try {
      if (field) {
        const relSchema = this.Model.$schema.relationships[field].type;
        const validate = {
          [relSchema.$sides[field].otherName]: Joi.number(),
        };
        if (relSchema.$extras) {
          for (const extra in relSchema.$extras) { // eslint-disable-line guard-for-in
            validate[extra] = Joi[relSchema.$extras[extra].type]();
          }
        }
        return validate;
      } else {
        const retVal = {};
        const attributes = this.Model.$schema.attributes;
        for (const attr in attributes) {
          if (!attributes[attr].readOnly) {
            retVal[attr] = Joi[attributes[attr].type]();
          }
        }
        return retVal;
      }
    } catch (err) {
      console.log(err);
      return {};
    }
  }

  loadHandler() {
    return {
      method: (request, reply) => {
        if (request.params && request.params.itemId) {
          const item = this.plump.find(this.Model.$name, request.params.itemId);
          return item.$get()
          .then((thing) => {
            if (thing) {
              reply(item);
            } else {
              reply(Boom.notFound());
            }
          }).catch((err) => {
            console.log(err);
            reply(Boom.badImplementation(err));
          });
        } else {
          return reply(Boom.notFound());
        }
      },
      assign: 'item',
    };
  }

  route(method, opts) {
    if (opts.plural) {
      return this.routeRelationship(method, opts);
    } else {
      return this.routeAttributes(method, opts);
    }
  }


  // override approveHandler with whatever per-route
  // logic you want - reply with Boom.notAuthorized()
  // or any other value on non-approved status
  approveHandler(method, opts) { // eslint-disable-line no-unused-vars
    return {
      method: (request, reply) => reply(true),
      assign: 'approve',
    };
  }

  routeRelationship(method, opts) {
    return Object.keys(this.Model.$schema.relationships).map(field => {
      const genericOpts = mergeOptions(
        {},
        opts,
        {
          validate: {},
          generatorOptions: { field: field },
        }
      );
      genericOpts.hapi.path = genericOpts.hapi.path.replace('{field}', field);
      if (['POST', 'PUT', 'PATCH'].indexOf(genericOpts.hapi.method) >= 0) {
        genericOpts.validate.payload = this.createJoiValidator(field);
      }
      genericOpts.plural = false;
      return this.routeAttributes(method, genericOpts);
    });
  }

  routeAttributes(method, opts) {
    /*
    opts: {
      pre: [ANY PREHANDLERs]
      handler: handler override
      validate: {Joi by type (param, query, payload)},
      auth: anything other than token,
      hapi: {ALL OTHER HAPI OPTIONS, MUST BE JSON STRINGIFYABLE},
    },
    */

    const routeConfig = mergeOptions(
      {},
      {
        handler: opts.handler || this.createHandler(method, opts.generatorOptions),
        config: {
          pre: [this.approveHandler(method, opts.generatorOptions)],
          validate: {},
        },
      },
      opts.hapi
    );

    if (opts.hapi.path.indexOf('itemId') >= 0) {
      routeConfig.config.pre.unshift(this.loadHandler());
    }

    if (opts.pre !== undefined) {
      opts.pre.forEach((p) => routeConfig.config.pre.push(p));
    }

    if (opts.validate && opts.validate.query) {
      routeConfig.config.validate.query = opts.validate.query;
    }

    if (opts.validate && opts.validate.params) {
      routeConfig.config.validate.params = opts.validate.params;
    }

    if (opts.validate && opts.validate.payload === true) {
      routeConfig.config.validate.payload = this.createJoiValidator();
    } else if (opts.validate && opts.validate.payload) {
      routeConfig.config.validate.payload = opts.validate.payload;
    }
    return routeConfig;
  }
}

BaseController.routes = [
  'read',
  'query',
  'listChildren',
  'addChild',
  'removeChild',
  'modifyChild',
  'create',
  'update',
  'delete',
];
