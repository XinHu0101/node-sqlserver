var sql = require('./lib/mssql');
var events = require('events');
var util = require('util');

function StreamEvents() {
    events.EventEmitter.call(this);
}
util.inherits(StreamEvents, events.EventEmitter);

function query_internal(ext, query, params, callback) {

    if (params.length > 0) {
        var combined = [];
        var split = query.split('?');
        for (var idx = 0; idx < split.length - 1; idx++) {
            combined.push(split[idx]);
            var value = params[idx];
            switch (typeof (value)) {
                case 'string': combined.push("'" + value.replace("'", "''") + "'"); break;
                case 'number': combined.push(value.toString()); break;
                default:
                    if (value instanceof Buffer) {
                        combined.push('0x' + value.toString('hex'));
                    }
                    else {
                        throw new Error('Invalid parameter type.  Support string, number, and Buffer');
                    }
            }
        }
        combined.push(split[split.length - 1]);
        query = combined.join("");
    }

    function onQuery(completed, err, results) {
        if (!completed) {
            ext.query(query, onQuery);
            return;
        }
        callback(err, results);
    }

    return ext.query(query, onQuery);
}


function getChunkyArgs(paramsOrCallback, callback) {
    if (callback) {
        return { params: paramsOrCallback || [], callback: callback };
    }
    else if (typeof (paramsOrCallback) === 'function') {
        return { params: [], callback: paramsOrCallback };
    }
    else {
        return { params: paramsOrCallback || [] };
    }
}

function objectify(results) {
    var names = {};
    var name, idx;
    for (idx in results.meta) {
        var meta = results.meta[idx];
        name = meta.name;
        if (name !== '' && names[name] === undefined) {
            names[name] = idx;
        }
        else {
            var extra = 0;
            var candidate = 'Column' + idx;
            while (names[candidate] !== undefined) {
                candidate = 'Column' + idx + '_' + extra++;
            }
            names[candidate] = idx;
        }
    }

    var rows = [];
    for (idx in results.rows) {
        var row = results.rows[idx];
        var value = {};
        for (name in names) {
            value[name] = row[names[name]];
        }
        rows.push(value);
    }

    return rows;
}

function readall(notify, ext, query, params, callback) {

    var meta;
    var column;
    var rows = [];
    var rowindex = 0;

    function onReadColumnMore(completed, err, results) {

        if (!completed) {
            ext.readColumn(column, onReadColumnMore);
            return;
        }

        if (err) {
            notify.emit('error', err);
            if (callback) {
                callback(err);
            }
            return;
        }

        var data = results.data;
        var more = results.more;

        notify.emit('column', column, data, more);

        if (callback) {
            rows[rows.length - 1][column] += data;
        }

        if (more) {
            ext.readColumn(column, onReadColumnMore);
            return;
        }

        column++;
        if (column >= meta.length) {
            ext.readRow(onReadRow);
            return;
        }

        ext.readColumn(column, onReadColumn);
    }

    function onReadColumn(completed, err, results) {

        if (!completed) {
            ext.readColumn(column, onReadColumn);
            return;
        }

        if (err) {
            notify.emit('error', err);
            if (callback) {
                callback(err);
            }
            return;
        }

        var data = results.data;
        var more = results.more;

        notify.emit('column', column, data, more);

        if (callback) {
            rows[rows.length - 1][column] = data;
        }

        if (more) {
            ext.readColumn(column, onReadColumnMore);
            return;
        }

        column++;

        if (column >= meta.length) {
            ext.readRow(onReadRow);
            return;
        }

        ext.readColumn(column, onReadColumn);
    }

    function onReadRow(completed, err, moreRows) {

        if (!completed) {
            ext.readRow(onReadRow);
        }
        
        if (err) {
            notify.emit('error', err);
            if (callback) {
                callback(err);
            }
        }
        else if (moreRows && meta.length > 0) {

            notify.emit('row', rowindex++);

            column = 0;
            if (callback) {
                rows[rows.length] = [];
            }
            ext.readColumn(column, onReadColumn);
        }
        else {
            notify.emit('done');
            if (callback) {
                callback(err, { meta: meta, rows: rows });
            }
        }
    }

    query_internal(ext, query, params, function (err, results) {

        if (err) {
            notify.emit('error', err);
            if (callback) {
                callback(err);
            }
            return;
        }

        meta = results;

        notify.emit('meta', meta);

        if (meta.length > 0) {
            ext.readRow(onReadRow);
        }
        else {
            notify.emit('done');
            if (callback) {
                callback(err, { meta: meta, rows: rows });
            }
        }
    });
}

function open(connectionString, callback) {

    var ext = new sql.Connection();

    function Connection() {
        this.beginTransaction = function (callback) {
            query_internal(ext, "BEGIN TRANSACTION DefaultTransaction", [], callback);
        }
        this.rollback = function (callback) {
            query_internal(ext, "ROLLBACK", [], callback);
        }
        this.commit = function (callback) {
            query_internal(ext, "COMMIT", [], callback);
        }
        this.close = function (callback) { ext.close(callback); }
        this.queryRaw = function (query, paramsOrCallback, callback) {
            var notify = new StreamEvents();

            var chunky = getChunkyArgs(paramsOrCallback, callback);
            readall(notify, ext, query, chunky.params, chunky.callback);

            return notify;
        }
        this.query = function (query, paramsOrCallback, callback) {

            var chunky = getChunkyArgs(paramsOrCallback, callback);

            function onQueryRaw(completed, err, results) {
                if (!completed) {
                    ext.queryRaw(query, chunky.params, onQueryRaw);
                    return;
                }
                if (chunky.callback) {
                    if (err) chunky.callback(err);
                    else chunky.callback(err, objectify(results));
                }
            }

            return this.queryRaw(query, chunky.params, onQueryRaw);
        }
    }

    function onOpen(completed, err) {
        if (!completed) {
            ext.open(connectionString, onOpen);
            return;
        }
        callback(err, connection);
    }

    var connection = new Connection();
    ext.open(connectionString, onOpen);
    return connection;
}

function query(connectionString, query, paramsOrCallback, callback) {

    var chunky = getChunkyArgs(paramsOrCallback, callback);

    return queryRaw(connectionString, query, chunky.params, function (err, results) {
        if (chunky.callback) {
            if (err) chunky.callback(err);
            else chunky.callback(err, objectify(results));
        }
    });
}

function queryRaw(connectionString, query, paramsOrCallback, callback) {
    var ext = new sql.Connection();
    var notify = new StreamEvents();

    var chunky = getChunkyArgs(paramsOrCallback, callback);

    function onOpen(completed, err, connection) {
        if (!completed) {
            ext.open(connectionString, onOpen);
            return;
        }
        if (err) {
            notify.on('error', err);
            if (chunky.callback) {
                chunky.callback(err);
            }
        }
        else {
            readall(notify, ext, query, chunky.params, function (err, results) {
                if (chunky.callback) {
                    chunky.callback(err, results);
                }
                ext.close();
            });
        }
    }

    ext.open(connectionString, onOpen);

    return notify;
}

exports.open = open;
exports.query = query; 
exports.queryRaw = queryRaw;