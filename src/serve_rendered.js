'use strict';

let advancedPool = require('advanced-pool');
let fs = require('fs');
let path = require('path');
let url = require('url');
let util = require('util');
let zlib = require('zlib');

// sharp has to be required before node-canvas
// see https://github.com/lovell/sharp/issues/371
let sharp = require('sharp');
let Canvas = require('canvas');
let clone = require('clone');
let Color = require('color');
let express = require('express');
let mercator = new (require('@mapbox/sphericalmercator'))();
let mbgl = require('@mapbox/mapbox-gl-native');
let mbtiles = require('@mapbox/mbtiles');
let proj4 = require('proj4');
let request = require('request');

let utils = require('./utils');
let markerSize = 12;
let FLOAT_PATTERN = '[+-]?(?:\\d+|\\d+\.?\\d+)';

let getScale = function(scale) {
  return (scale || '@1x').slice(1, 2) | 0;
};

mbgl.on('message', function(e) {
  if (e.severity == 'WARNING' || e.severity == 'ERROR') {
    console.log('mbgl:', e);
  }
});

/**
 * Lookup of sharp output formats by file extension.
 */
let extensionToFormat = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

/**
 * Cache of response data by sharp output format and color.  Entry for empty
 * string is for unknown or unsupported formats.
 */
let cachedEmptyResponses = {
  '': new Buffer(0)
};

/**
 * Create an appropriate mbgl response for http errors.
 * @param {string} format The format (a sharp format or 'pbf').
 * @param {string} color The background color (or empty string for transparent).
 * @param {Function} callback The mbgl callback.
 */
function createEmptyResponse(format, color, callback) {
  if (!format || format === 'pbf') {
    callback(null, { data: cachedEmptyResponses[''] });
    return;
  }
  let array = color.array();
  let channels = array.length == 4 && format != 'jpeg' ? 4 : 3;
  sharp(new Buffer(array), {
    raw: {
      width: 1,
      height: 1,
      channels: channels
    }
  }).toFormat(format).toBuffer(function(err, buffer, info) {
    if (!err) {
      cachedEmptyResponses[cacheKey] = buffer;
    }
    callback(null, { data: buffer });
  });
}

module.exports = function(options, repo, params, id, dataResolver) {
  var app = express().disable('x-powered-by');

  var maxScaleFactor = Math.min(Math.floor(options.maxScaleFactor || 3), 9);
  var scalePattern = '';
  for (var i = 2; i <= maxScaleFactor; i++) {
    scalePattern += i.toFixed();
  }
  scalePattern = '@[' + scalePattern + ']x';
  4
  var lastModified = new Date().toUTCString();

  // var rootPath = options.paths.root;

  var watermark = params.watermark || options.watermark;

  var styleFile = params.style;
  var map = {
    renderers: [],
    sources: {}
  };

  var existingFonts = {};
  var fontListingPromise = new Promise(function(resolve, reject) {
    fs.readdir(options.paths.fonts, function(err, files) {
      if (err) {
        reject(err);
        return;
      }
      files.forEach(function(file) {
        fs.stat(path.join(options.paths.fonts, file), function(err, stats) {
          if (err) {
            reject(err);
            return;
          }
          if (stats.isDirectory()) {
            existingFonts[path.basename(file)] = true;
          }
        });
      });
      resolve();
    });
  });

  var styleJSON;
  var createPool = function(ratio, min, max) {
    var createRenderer = function(ratio, createCallback) {
      var renderer = new mbgl.Map({
        ratio: ratio,
        request: function(req, callback) {
          let protocol = req.url.split(':')[0];
          //console.log('Handling request:', req);
          if (protocol == 'sprites') {
            let dir = options.paths[protocol];
            let file = unescape(req.url).substring(protocol.length + 3);
            fs.readFile(path.join(dir, file), function(err, data) {
              callback(err, { data: data });
            });
          } else if (protocol == 'fonts') {
            let parts = req.url.split('/');
            let fontstack = unescape(parts[2]);
            let range = parts[3].split('.')[0];
            utils.getFontsPbf(
              null, options.paths[protocol], fontstack, range, existingFonts
            ).then(function(concated) {
              callback(null, { data: concated });
            }, function(err) {
              callback(err, { data: null });
            });
          } else if (protocol == 'mbtiles') {
            let parts = req.url.split('/');
            let sourceId = parts[2];
            let source = map.sources[sourceId];
            let sourceInfo = styleJSON.sources[sourceId];
            let z = parts[3] | 0,
              x = parts[4] | 0,
              y = parts[5].split('.')[0] | 0,
              format = parts[5].split('.')[1];
            source.getTile(z, x, y, function(err, data, headers) {
              if (err) {
                //console.log('MBTiles error, serving empty', err);
                createEmptyResponse(sourceInfo.format, sourceInfo.color, callback);
                return;
              }

              let response = {};
              if (headers['Last-Modified']) {
                response.modified = new Date(headers['Last-Modified']);
              }

              if (format == 'pbf') {
                try {
                  response.data = zlib.unzipSync(data);
                }
                catch (err) {
                  console.log("Skipping incorrect header for tile mbtiles://%s/%s/%s/%s.pbf", id, z, x, y);
                }
                if (options.dataDecoratorFunc) {
                  response.data = options.dataDecoratorFunc(
                    sourceId, 'data', response.data, z, x, y);
                }
              } else {
                response.data = data;
              }

              callback(null, response);
            });
          } else if (protocol === 'http' || protocol === 'https') {
            request({
              url: req.url,
              encoding: null,
              gzip: true
            }, function(err, res, body) {
              let parts = url.parse(req.url);
              let extension = path.extname(parts.pathname).toLowerCase();
              let format = extensionToFormat[extension] || '';
              if (err || res.statusCode < 200 || res.statusCode >= 300) {
                // console.log('HTTP error', err || res.statusCode);
                createEmptyResponse(format, '', callback);
                return;
              }

              let response = {};
              if (res.headers.modified) {
                response.modified = new Date(res.headers.modified);
              }
              if (res.headers.expires) {
                response.expires = new Date(res.headers.expires);
              }
              if (res.headers.etag) {
                response.etag = res.headers.etag;
              }

              response.data = body;
              callback(null, response);
            });
          }
        }
      });
      renderer.load(styleJSON);
      createCallback(null, renderer);
    };
    return new advancedPool.Pool({
      min: min,
      max: max,
      create: createRenderer.bind(null, ratio),
      destroy: function(renderer) {
        renderer.release();
      }
    });
  };

  let styleJSONPath = path.resolve(options.paths.styles, styleFile);
  styleJSON = clone(require(styleJSONPath));

  let httpTester = /^(http(s)?:)?\/\//;
  if (styleJSON.sprite && !httpTester.test(styleJSON.sprite)) {
    styleJSON.sprite = 'sprites://' +
      styleJSON.sprite
        .replace('{style}', path.basename(styleFile, '.json'))
        .replace('{styleJsonFolder}', path.relative(options.paths.sprites, path.dirname(styleJSONPath)));
  }
  if (styleJSON.glyphs && !httpTester.test(styleJSON.glyphs)) {
    styleJSON.glyphs = 'fonts://' + styleJSON.glyphs;
  }

  let tileJSON = {
    'tilejson': '2.0.0',
    'name': styleJSON.name,
    'attribution': '',
    'minzoom': 0,
    'maxzoom': 20,
    'bounds': [-180, -85.0511, 180, 85.0511],
    'format': 'png',
    'type': 'baselayer'
  };
  let attributionOverride = params.tilejson && params.tilejson.attribution;
  Object.assign(tileJSON, params.tilejson || {});
  tileJSON.tiles = params.domains || options.domains;
  utils.fixTileJSONCenter(tileJSON);

  var dataProjWGStoInternalWGS = null;

  var queue = [];
  Object.keys(styleJSON.sources).forEach(function(name) {
    let source = styleJSON.sources[name];
    let url = source.url;

    if (url && url.lastIndexOf('mbtiles:', 0) === 0) {
      // found mbtiles source, replace with info from local file
      delete source.url;

      let mbtilesFile = url.substring('mbtiles://'.length);
      let fromData = mbtilesFile[0] == '{' &&
        mbtilesFile[mbtilesFile.length - 1] == '}';

      if (fromData) {
        mbtilesFile = mbtilesFile.substr(1, mbtilesFile.length - 2);
        let mapsTo = (params.mapping || {})[mbtilesFile];
        if (mapsTo) {
          mbtilesFile = mapsTo;
        }
        mbtilesFile = dataResolver(mbtilesFile);
        if (!mbtilesFile) {
          console.error('ERROR: data "' + mbtilesFile + '" not found!');
          process.exit(1);
        }
      }

      queue.push(new Promise(function(resolve, reject) {
        mbtilesFile = path.resolve(options.paths.mbtiles, mbtilesFile);
        let mbtilesFileStats = fs.statSync(mbtilesFile);
        if (!mbtilesFileStats.isFile() || mbtilesFileStats.size == 0) {
          throw Error('Not valid MBTiles file: ' + mbtilesFile);
        }
        map.sources[name] = new mbtiles(mbtilesFile, function(err) {
          map.sources[name].getInfo(function(err, info) {
            if (err) {
              console.error(err);
              return;
            }

            if (!dataProjWGStoInternalWGS && info.proj4) {
              // how to do this for multiple sources with different proj4 defs?
              let to3857 = proj4('EPSG:3857');
              let toDataProj = proj4(info.proj4);
              dataProjWGStoInternalWGS = function(xy) {
                return to3857.inverse(toDataProj.forward(xy));
              };
            }

            let type = source.type;
            Object.assign(source, info);
            source.type = type;
            source.tiles = [
              // meta url which will be detected when requested
              'mbtiles://' + name + '/{z}/{x}/{y}.' + (info.format || 'pbf')
            ];
            delete source.scheme;

            if (options.dataDecoratorFunc) {
              source = options.dataDecoratorFunc(name, 'tilejson', source);
            }

            if (!attributionOverride &&
              source.attribution && source.attribution.length > 0) {
              if (tileJSON.attribution.length > 0) {
                tileJSON.attribution += '; ';
              }
              tileJSON.attribution += source.attribution;
            }
            resolve();
          });
        });
      }));
    }
  });

  var renderersReadyPromise = Promise.all(queue).then(function() {
    // standard and @2x tiles are much more usual -> default to larger pools
    let minPoolSizes = options.minRendererPoolSizes || [8, 4, 2];
    let maxPoolSizes = options.maxRendererPoolSizes || [16, 8, 4];
    for (let s = 1; s <= maxScaleFactor; s++) {
      let i = Math.min(minPoolSizes.length - 1, s - 1);
      let j = Math.min(maxPoolSizes.length - 1, s - 1);
      let minPoolSize = minPoolSizes[i];
      let maxPoolSize = Math.max(minPoolSize, maxPoolSizes[j]);
      map.renderers[s] = createPool(s, minPoolSize, maxPoolSize);
    }
  });

  repo[id] = tileJSON;

  var tilePattern = '/' + id + '/:z(\\d+)/:x(\\d+)/:y(\\d+)' +
    ':scale(' + scalePattern + ')?\.:format([\\w]+)';

  var respondImage = function(z, lon, lat, bearing, pitch,
    width, height, scale, format, res, next,
    opt_overlay) {
    if (Math.abs(lon) > 180 || Math.abs(lat) > 85.06 ||
      lon != lon || lat != lat) {
      return res.status(400).send('Invalid center');
    }
    if (Math.min(width, height) <= 0 ||
      Math.max(width, height) * scale > (options.maxSize || 2048) ||
      width != width || height != height) {
      return res.status(400).send('Invalid size');
    }

    let formatIndex = ['jpg', 'jpeg', 'png', 'webp'].indexOf(format);

    if (formatIndex == -1) {
      return res.status(400).send('Invalid format');
    } else if (formatIndex < 2) {
      format = 'jpeg';
    }

    let pool = map.renderers[scale];
    pool.acquire(function(err, renderer) {
      let mbglZ = Math.max(0, z - 1);
      let params = {
        zoom: mbglZ,
        center: [lon, lat],
        bearing: bearing,
        pitch: pitch,
        width: width,
        height: height
      };
      if (z == 0) {
        params.width *= 2;
        params.height *= 2;
      }
      renderer.render(params, function(err, data) {
        pool.release(renderer);
        if (err) {
          console.error(err);
          return;
        }

        let image = sharp(data, {
          raw: {
            width: params.width * scale,
            height: params.height * scale,
            channels: 4
          }
        });

        if (z == 0) {
          // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
          image.resize(width * scale, height * scale);
        }

        if (opt_overlay) {
          image.overlayWith(opt_overlay);
        }
        if (watermark) {
          let canvas = new Canvas(scale * width, scale * height);
          let ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.font = '10px sans-serif';
          ctx.strokeWidth = '1px';
          ctx.strokeStyle = 'rgba(255,255,255,.4)';
          ctx.strokeText(watermark, 5, height - 5);
          ctx.fillStyle = 'rgba(0,0,0,.4)';
          ctx.fillText(watermark, 5, height - 5);

          image.overlayWith(canvas.toBuffer());
        }

        let formatQuality = (params.formatQuality || {})[format] ||
          (options.formatQuality || {})[format];

        if (format == 'png') {
          image.png({ adaptiveFiltering: false });
        } else if (format == 'jpeg') {
          image.jpeg({ quality: formatQuality || 80 });
        } else if (format == 'webp') {
          image.webp({ quality: formatQuality || 90 });
        }
        image.toBuffer(function(err, buffer, info) {
          if (!buffer) {
            return res.status(404).send('Not found');
          }

          res.set({
            'Last-Modified': lastModified,
            'Content-Type': 'image/' + format
          });
          return res.status(200).send(buffer);
        });
      });
    });
  };

  app.get(tilePattern, function(req, res, next) {
    let modifiedSince = req.get('if-modified-since'), cc = req.get('cache-control');
    if (modifiedSince && (!cc || cc.indexOf('no-cache') == -1)) {
      if (new Date(lastModified) <= new Date(modifiedSince)) {
        return res.sendStatus(304);
      }
    }

    let z = req.params.z | 0,
      x = req.params.x | 0,
      y = req.params.y | 0,
      scale = getScale(req.params.scale),
      format = req.params.format;
    if (z < 0 || x < 0 || y < 0 ||
      z > 20 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
      return res.status(404).send('Out of bounds');
    }
    let tileSize = 256;
    let tileCenter = mercator.ll([
      ((x + 0.5) / (1 << z)) * (256 << z),
      ((y + 0.5) / (1 << z)) * (256 << z)
    ], z);
    return respondImage(z, tileCenter[0], tileCenter[1], 0, 0,
      tileSize, tileSize, scale, format, res, next);
  });

  var extractPathFromQuery = function(query, transformer) {
    let pathParts = (query.path || '').split('|');
    let path = [];
    pathParts.forEach(function(pair) {
      let pairParts = pair.split(',');
      if (pairParts.length == 2) {
        let pair;
        if (query.latlng == '1' || query.latlng == 'true') {
          pair = [+(pairParts[1]), +(pairParts[0])];
        } else {
          pair = [+(pairParts[0]), +(pairParts[1])];
        }
        if (transformer) {
          pair = transformer(pair);
        }
        path.push(pair);
      }
    });
    return path;
  };

  var drawMarker = function(ctx, coordinates, scale, outerColour = "rgb(0,0,0)", innerColour = "rgb(255,255,255)", outerRadius = markerSize, innerRadius = markerSize * 0.35) {

    //[outerRadius, innerRadius, coordinates[0], coordinates[1]].map(console.log);

    outerRadius = parseInt(outerRadius);
    innerRadius = parseInt(innerRadius);
    let x = parseInt(coordinates[0]);
    let y = parseInt(coordinates[1]);

    let validParams = [outerRadius, innerRadius, x, y].reduce(function(acc, element) {
      if (isNaN(element)) {
        console.log("element: " + element + " is invalid.");
      }
      return acc && !isNaN(element);
    }, true);

    if (!validParams) {
      console.log("invalid parameters!");
    }
    // outer circle.
    ctx.beginPath();
    ctx.arc(x, y, outerRadius, 0, 2 * Math.PI, false);
    ctx.fillStyle = outerColour;
    ctx.fill();

    // inner circle.
    ctx.beginPath();
    ctx.arc(x, y, innerRadius, 0, 2 * Math.PI, false);
    ctx.fillStyle = innerColour;
    ctx.fill();
  }

  var renderOverlay = function(z, x, y, bearing, pitch, w, h, scale,
    path, query) {
    if (!path || path.length < 2) {
      return null;
    }
    var precisePx = function(ll, zoom) {
      var px = mercator.px(ll, 20);
      var scale = Math.pow(2, zoom - 20);
      return [px[0] * scale, px[1] * scale];
    };

    var center = precisePx([x, y], z);

    var mapHeight = 512 * (1 << z);
    var maxEdge = center[1] + h / 2;
    var minEdge = center[1] - h / 2;
    if (maxEdge > mapHeight) {
      center[1] -= (maxEdge - mapHeight);
    } else if (minEdge < 0) {
      center[1] -= minEdge;
    }

    var canvas = new Canvas(scale * w, scale * h);
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    if (bearing) {
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-bearing / 180 * Math.PI);
      ctx.translate(-center[0], -center[1]);
    } else {
      // optimized path
      ctx.translate(-center[0] + w / 2, -center[1] + h / 2);
    }
    var lineWidth = query.width !== undefined ?
      parseFloat(query.width) : 1;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = query.stroke || 'rgba(0,64,255,0.7)';
    ctx.fillStyle = query.fill || 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    path.forEach(function(pair) {
      var px = precisePx(pair, z);
      ctx.lineTo(px[0], px[1]);
    });
    if (path[0][0] == path[path.length - 1][0] &&
      path[0][1] == path[path.length - 1][1]) {
      ctx.closePath();
    }
    ctx.fill();
    if (lineWidth > 0) {
      ctx.stroke();
    }

    if (query.showMarkers && query.showMarkers == 1) {
      // Add the markers, if requested to do so.
      if (query.cancelledRide && query.cancelledRide == 1) {
        // Check if markers are for cancelled ride
        drawMarker(ctx, precisePx(path[path.length - 1], z), scale, "rgba(140, 140, 158, .9)", "rgba(0, 0, 0, 0.9)");
      } else {
        drawMarker(ctx, precisePx(path[path.length - 1], z), scale, "rgba(100, 206, 172, .9)");
      }
      drawMarker(ctx, precisePx(path[0], z), scale, "rgba(0, 0, 0, .9)");
    }

    return canvas.toBuffer();
  };

  var calcZForBBox = function(bbox, w, h, query) {
    var z = 25;

    var padding = query.padding !== undefined ?
      parseFloat(query.padding) : 0.1;

    var minCorner = mercator.px([bbox[0], bbox[3]], z),
      maxCorner = mercator.px([bbox[2], bbox[1]], z);
    var w_ = w / (1 + 2 * padding);
    var h_ = h / (1 + 2 * padding);

    z -= Math.max(
      Math.log((maxCorner[0] - minCorner[0]) / w_),
      Math.log((maxCorner[1] - minCorner[1]) / h_)
    ) / Math.LN2;

    z = Math.max(Math.log(Math.max(w, h) / 256) / Math.LN2, Math.min(25, z));

    return z;
  };

  if (options.serveStaticMaps !== false) {
    var staticPattern =
      '/' + id + '/static/:raw(raw)?/%s/:width(\\d+)x:height(\\d+)' +
      ':scale(' + scalePattern + ')?.:format([\\w]+)';

    var centerPattern =
      util.format(':x(%s),:y(%s),:z(%s)(@:bearing(%s)(,:pitch(%s))?)?',
        FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN,
        FLOAT_PATTERN, FLOAT_PATTERN);

    app.get(util.format(staticPattern, centerPattern), function(req, res, next) {
      let raw = req.params.raw;
      let z = +req.params.z,
        x = +req.params.x,
        y = +req.params.y,
        bearing = +(req.params.bearing || '0'),
        pitch = +(req.params.pitch || '0'),
        w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      if (z < 0) {
        return res.status(400).send('Invalid zoom');
      }

      let transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      if (transformer) {
        let ll = transformer([x, y]);
        x = ll[0];
        y = ll[1];
      }

      let path = extractPathFromQuery(req.query, transformer);
      let overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);

      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    });

    let serveBounds = function(req, res, next) {
      let raw = req.params.raw;
      let bbox = [+req.params.minx, +req.params.miny,
      +req.params.maxx, +req.params.maxy];
      let center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

      let transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      if (transformer) {
        let minCorner = transformer(bbox.slice(0, 2));
        let maxCorner = transformer(bbox.slice(2));
        bbox[0] = minCorner[0];
        bbox[1] = minCorner[1];
        bbox[2] = maxCorner[0];
        bbox[3] = maxCorner[1];
        center = transformer(center);
      }

      let w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      let z = calcZForBBox(bbox, w, h, req.query),
        x = center[0],
        y = center[1],
        bearing = 0,
        pitch = 0;

      let path = extractPathFromQuery(req.query, transformer);
      let overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);
      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    };

    let boundsPattern =
      util.format(':minx(%s),:miny(%s),:maxx(%s),:maxy(%s)',
        FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN);

    app.get(util.format(staticPattern, boundsPattern), serveBounds);

    app.get('/' + id + '/static/', function(req, res, next) {
      for (var key in req.query) {
        req.query[key.toLowerCase()] = req.query[key];
      }
      req.params.raw = true;
      req.params.format = (req.query.format || 'image/png').split('/').pop();
      var bbox = (req.query.bbox || '').split(',');
      req.params.minx = bbox[0];
      req.params.miny = bbox[1];
      req.params.maxx = bbox[2];
      req.params.maxy = bbox[3];
      req.params.width = req.query.width || '256';
      req.params.height = req.query.height || '256';
      if (req.query.scale) {
        req.params.width /= req.query.scale;
        req.params.height /= req.query.scale;
        req.params.scale = '@' + req.query.scale;
      }

      return serveBounds(req, res, next);
    });

    let autoPattern = 'auto';

    app.get(util.format(staticPattern, autoPattern), function(req, res, next) {
      let raw = req.params.raw;
      let w = req.params.width | 0,
        h = req.params.height | 0,
        bearing = 0,
        pitch = 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      let transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      let path = extractPathFromQuery(req.query, transformer);
      if (path.length < 2) {
        return res.status(400).send('Invalid path');
      }

      let bbox = [Infinity, Infinity, -Infinity, -Infinity];
      path.forEach(function(pair) {
        bbox[0] = Math.min(bbox[0], pair[0]);
        bbox[1] = Math.min(bbox[1], pair[1]);
        bbox[2] = Math.max(bbox[2], pair[0]);
        bbox[3] = Math.max(bbox[3], pair[1]);
      });

      let bbox_ = mercator.convert(bbox, '900913');
      let center = mercator.inverse(
        [(bbox_[0] + bbox_[2]) / 2, (bbox_[1] + bbox_[3]) / 2]
      );

      let z = calcZForBBox(bbox, w, h, req.query),
        x = center[0],
        y = center[1];

      let overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);

      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    });
  }

  app.get('/' + id + '.json', function(req, res, next) {
    let info = clone(tileJSON);
    info.tiles = utils.getTileUrls(req, info.tiles,
      'styles/' + id, info.format);
    return res.send(info);
  });

  return Promise.all([fontListingPromise, renderersReadyPromise]).then(function() {
    return app;
  });

};
