// add multiple serviceaccounts as {}, {}, {}, random account will be selected by each time app is opened.
const serviceaccounts = [
{}
];
var config = {
    client_id: '',
    client_secret: '',
    refresh_token: '', // your refresh_token
    service_account: false, // true if you're using Service Account instead of user account
    service_account_json: serviceaccounts[Math.floor(Math.random()*serviceaccounts.length)], // don't touch this one
    link: 'https://github.com/PBhadoo/google-drive-webdav-workers',
    name: 'GitHub',
    theme: 'material',
    users: {
        'user': 'password' // webdav user
    },
    working_dir: '/',
    cache: {
        meta: {
            '/': {
                id: '', // public directory id
                mimeType: 'application/vnd.google-apps.folder',
                size: 0,
                modifiedTime: null
            },
            '/dav/': {
                id: '', // DAV directory id
                mimeType: 'application/vnd.google-apps.folder',
                size: 0,
                modifiedTime: null
            }
        },
        putUrl: {},
        config: {}
    }
}

const JSONWebToken = {
    header: {
        alg: 'RS256',
        typ: 'JWT'
    },
    importKey: async function(pemKey) {
        var pemDER = this.textUtils.base64ToArrayBuffer(pemKey.split('\n').map(s => s.trim()).filter(l => l.length && !l.startsWith('---')).join(''));
        return crypto.subtle.importKey('pkcs8', pemDER, {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256'
        }, false, ['sign']);
    },
    createSignature: async function(text, key) {
        const textBuffer = this.textUtils.stringToArrayBuffer(text);
        return crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textBuffer)
    },
    generateGCPToken: async function(serviceAccount) {
        const iat = parseInt(Date.now() / 1000);
        var payload = {
            "iss": serviceAccount.client_email,
            "scope": "https://www.googleapis.com/auth/drive",
            "aud": "https://oauth2.googleapis.com/token",
            "exp": iat + 3600,
            "iat": iat
        };
        const encPayload = btoa(JSON.stringify(payload));
        const encHeader = btoa(JSON.stringify(this.header));
        var key = await this.importKey(serviceAccount.private_key);
        var signed = await this.createSignature(encHeader + "." + encPayload, key);
        return encHeader + "." + encPayload + "." + this.textUtils.arrayBufferToBase64(signed).replace(/\//g, '_').replace(/\+/g, '-');
    },
    textUtils: {
        base64ToArrayBuffer: function(base64) {
            var binary_string = atob(base64);
            var len = binary_string.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        },
        stringToArrayBuffer: function(str) {
            var len = str.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
                bytes[i] = str.charCodeAt(i);
            }
            return bytes.buffer;
        },
        arrayBufferToBase64: function(buffer) {
            let binary = '';
            let bytes = new Uint8Array(buffer);
            let len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }
    }
};


const cache = {
    get: async (k, ns) => {
        // mem
        if (config.cache[ns] && config.cache[ns][k]) {
            // console.log('mem cached: ' + ns + '.' + k)
            // console.log(config.cache[ns][k])
            return config.cache[ns][k]
        }

        // kv
        if (typeof KV !== 'undefined') {
            const v = await KV.get(ns + '.' + k, {type: 'json'})
            if (v) {
                config.cache[ns][k] = v
                // console.log('kv cached: ' + ns + '.' + k)
                // console.log(v)
                return v
            }
        }

        return null
    },
    put: async (k, v, ns) => {
        if (v) {
            config.cache[ns][k] = v
            typeof KV !== 'undefined' && KV.put(ns + '.' + k, JSON.stringify(v))
            // console.log('put kv cache: ' + ns + '.' + k)
            // console.log(v)
        }
    },
    delete: async (k, ns) => {
        if (ns == 'meta' && !k.endsWith('/')) k += '/'
        config.cache[ns][k] = null
        typeof KV !== 'undefined' && KV.delete(ns + '.' + k)
    }
}

const gdrive = {
    methods: {
        OPTIONS: (request) => {
            let allowed_methods = [
                'GET', 'HEAD', 'OPTIONS', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE', 'MOVE', 'COPY'
            ].join(',');
    
            return new Response(null, {
                status: 200,
                headers: {
                    'Allow': allowed_methods,
                    'DAV': '1, 2, 3',
                    'MS-Author-Via': 'DAV',
                    'Accept-Ranges': 'bytes'
                }
            })
    
        },
        PROPFIND: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
            const metadata = await gdrive.getMetadata(fpath)
    
            if (!metadata) {
                return new Response(null, {status: 404})
            }

            
            let content;
            if (metadata.mimeType == 'application/vnd.google-apps.folder') {
                const depth = request.headers.get('Depth')
                if (depth && depth == '1') {
                    const objects = await gdrive.getObjects(metadata.id)
                    let files = [];
                    objects.map(function(object) {
                        files.push({
                            name: object.name,
                            dir: object.mimeType == 'application/vnd.google-apps.folder',
                            lastmodified: new Date(object.modifiedTime).toGMTString(),
                            size: object.size ? object.size : 0
                        })
                    })

                    content = arrayToXml(rpath, [ {name: '', dir: true, lastmodified: null, size: 0} ].concat(files || []), '');
                } else {
                    // depth 0
                    content = arrayToXml(rpath, [{
                        name: rpath,
                        dir: true,
                        lastmodified: new Date(metadata.modifiedTime).toGMTString(),
                        size: metadata.size,
                        quota: (rpath == '/' || rpath == '/dav/') ? await gdrive.getQuota() : null
                    }]);
                }
            } else {
                content = arrayToXml(rpath, [{
                    name: '', // metadata.name
                    dir: false,
                    lastmodified: new Date(metadata.modifiedTime).toGMTString(),
                    size: metadata.size
                }]);
            }
    
            // HTTP/1.1 207 Multi-Status
            response = new Response(content, {
                status: 207,
                headers: {
                    'Content-Type': 'application/xml; charset=utf-8'
                }
            })
    
            return response
        },
        MKCOL: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
    
            if (fpath.slice(-1) === '/') {
                fpath = fpath.slice(0, -1)
            }
    
            let metadata = await gdrive.getMetadata(fpath)
            if (metadata){
                return new Response('<d:error xmlns:d="DAV:" xmlns:td="https://www.contoso.com/schema/"><td:exception>MethodNotAllowed</td:exception><td:message>The resource you tried to create already exists</td:message></d:error>', {status: 405})
            }
    
            const tok = fpath.split('/');
            const name = tok.pop();
            const parent = tok.join('/');
    
            metadata = await gdrive.getMetadata(parent)
            if (!metadata) {
                return new Response(null, {status: 404})
            }
    
            let response = await fetch(new Request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true', {
                body: JSON.stringify({
                    name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [metadata.id]
                }),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                }
            }))
    
            if (response.ok == true) {
                return new Response(null, {status: 201})
            }
    
            return new Response(null, {status: 422})
        },
        GET: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
            let url = new URL(request.url)
    
            let response
            const metadata = await gdrive.getMetadata(fpath)
            if (metadata){
                try {
                    // Folder
                    if (metadata.mimeType == 'application/vnd.google-apps.folder') {
                        const objects = await gdrive.getObjects(metadata.id)
                        let files = [];
                        objects.map(function(object) {
                            files.push({
                                name: gdrive._trim(object.name, '/'),
                                dir: object.mimeType == 'application/vnd.google-apps.folder',
                                lastmodified: new Date(object.modifiedTime).toISOString().split('T')[0],
                                size: object.size ? object.size : 0,
                                iconLink: object.iconLink
                            })
                        })

                        return new Response(arrayToHtml(rpath, files, ''), {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html; charset=utf-8'
                            }
                        })
                    }
    
                    // Image file response
                    if (metadata.mimeType.startsWith('image/')) {
                        // tempLink expires after one hour
                        const tempLink = metadata.thumbnailLink.replace(/=s\d+$/, '')
                        url.param = url.param || '=s0' // thumbnail or original
                        return await fetch(new Request(tempLink + url.param, request))
                    }
    
                    // Other file response
                    const abuse = url.searchParams.get('abuse') == 'true'
                    const range = request.headers.get('Range')
                    response = await gdrive.getRawContent(metadata.id, range, abuse)
                    if (response.status >= 400) {
                        const result = await response.json()
                        // try download abusive file
                        if (!abuse && response.status == 403 && result.error.errors[0].reason == 'cannotDownloadAbusiveFile') {
                            return Response.redirect(url.origin + pathname + '?abuse=true', 302)
                        }
                        const error = new Error(result.error.message)
                        error.status = response.status
                        throw error
                    }
                } catch(e) {
                    console.error(e);
                    response = new Response(e.message, {status: 500})
                }
            } else {
                response = new Response(null, {status: 404})
            }
            return response
        },
        PUT: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
    
            if (fpath.slice(-1) === '/') {
              return new Response(null, {status: 405});
            }

            const contentLength = request.headers.get('Content-Length')

            // resumable
            let putUrl
            if (config.cache.putUrl[fpath]) {
                putUrl = config.cache.putUrl[fpath]
            } else {
                const tok = fpath.split('/');
                const name = tok.pop();
                const parent = tok.join('/');
    
                const parentMetadata = await gdrive.getMetadata(parent)
        
                if (!parentMetadata) {
                    return new Response(null, {status: 404})
                }

                // delete old
                const metadata = await gdrive.getMetadata(fpath)
                if (metadata) {
                    const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id, {
                        method: 'DELETE',
                        headers: {
                            Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                        }
                    })
                    cache.delete(fpath, 'meta')
                }
                
                // upload
                let response = await fetch(new Request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&includeItemsFromAllDrives=true', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=UTF-8',
                        Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                    },
                    body: JSON.stringify({
                        name,
                        parents: [parentMetadata.id]
                    })
                }))

                putUrl = response.headers.get('Location');
                if (!putUrl) {
                    return new Response(JSON.stringify(response), {status: 403})
                }

                config.cache.putUrl[fpath] = putUrl
            }
            response = await fetch(putUrl, {
                body: request.body,
                method: 'PUT',
                headers: {
                    Authorization: 'Bearer ' + (await gdrive.getAccessToken()),
                    'Content-Length': contentLength
                }
            });

            if (response.status != 409) {
                config.cache.putUrl[fpath] = null
                cache.delete(fpath, 'meta')
            }

            if (response.status <= 201) {
                return new Response(null, {status: 201})
            }

            return new Response(JSON.stringify(response), {status: response.status})

        },
        MOVE: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
    
            // disable rename root folder
            if (rpath === '/' || rpath === '/dav/') {
                return new Response(null, {status: 403})
            }
    
            let destination = request.headers.get('Destination');
    
            if (!destination) {
                return new Response(null, {status: 403})
            }
            
            const dest_fpath = gdrive.pathJoin(config.working_dir,  decodeURIComponent(new URL(destination).pathname))
    
            const metadata = await gdrive.getMetadata(fpath)
            if (!metadata) {
                return new Response(null, {status: 404})
            }
    
            const tok = fpath.split('/');
            const name = tok.pop();
            const parent = tok.join('/');
    
            const dest_tok = dest_fpath.split('/');
            const dest_name = dest_tok.pop();
            const dest_parent = dest_tok.join('/');
    
            let patchUrl;
            if (dest_parent !== parent) {
                const dest_metadata = await gdrive.getMetadata(dest_parent)
                if (!dest_metadata) {
                    return new Response(null, {status: 404})
                }
                patchUrl = 'removeParents=' + metadata.parents.pop() + '&addParents=' + dest_metadata.id
            }
    
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?' + patchUrl, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                },
                body: name !== dest_name ? JSON.stringify({
                    name: dest_name
                }) : null
            })
    
            const result = await response.json()
    
            if (result.id) {
                cache.delete(fpath, 'meta')

                return new Response(null, {
                    status: 201,
                    headers: {
                        'Location': destination
                    }
                })
            }
        },
        COPY: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)
    
            let destination = request.headers.get('Destination');
            if (!destination) {
                return new Response(null, {status: 403})
            }

            let dest_rpath = decodeURIComponent(new URL(destination).pathname);

            // disable copy root folder
            if (dest_rpath === '/' || dest_rpath === '/dav/') {
                return new Response(null, {status: 403})
            }

            let dest_fpath = gdrive.pathJoin(config.working_dir, dest_rpath);
    
            const metadata = await gdrive.getMetadata(fpath)
            if (!metadata) {
                return new Response(null, {status: 404})
            }
    
            const tok = fpath.split('/');
            const name = tok.pop();
            const parent = tok.join('/');
    
            const dest_tok = dest_fpath.split('/');
            const dest_name = dest_tok.pop();
            const dest_parent = dest_tok.join('/');
    
            let parents = metadata.parents
            if (dest_parent !== parent) {
                const dest_metadata = await gdrive.getMetadata(dest_parent)
                if (!dest_metadata) {
                    return new Response(null, {status: 404})
                }
                parents = [dest_metadata.id]
            }
    
            const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '/copy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                },
                body: JSON.stringify({
                    name: dest_name,
                    parents: parents
                })
            })
    
            return new Response(null, {status: 201})
        },
        DELETE: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)

            if (rpath == '/' || rpath == '/dav/') {
                return new Response(null, {status: 403})
            }

            const metadata = await gdrive.getMetadata(fpath)
            if (metadata){
                const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id, {
                    method: 'DELETE',
                    headers: {
                        Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                    }
                })
    
                cache.delete(fpath, 'meta')
                return new Response(null, {status: response.status})
            }
    
            return new Response(null, {status: 404})
        },
        HEAD: async (request) => {
            let { rpath, fpath } = gdrive.getUrl(request.url)

            const metadata = await gdrive.getMetadata(fpath)
            if (metadata){
                const response = await fetch('https://www.googleapis.com/drive/v3/files/' + metadata.id + '?fields=id,name,mimeType,size,modifiedTime', {
                    headers: {
                        Authorization: 'Bearer ' + (await gdrive.getAccessToken())
                    }
                })
                const result = await response.json()
                if (result) {
                    return new Response(null, {
                        status: 200,
                        headers: {
                            'Content-Length': result.mimeType,
                            'Content-Type': result.size,
                            'date': new Date(result.modifiedTime).toGMTString()
                        }
                    })
                }
            }
            
            return new Response(null, {status: 404})
        },
        // hack
        LOCK: async () => {
            return new Response(null, {status: 200})
        },
        UNLOCK: async () => {
            return new Response(null, {status: 200})
        },
        PROPPATCH: async () => {
            return new Response(null, {status: 200})
        }
    },
    getMetadata: async (path) => {
        path = path.startsWith('/') ? path : '/' + path
        path = path.endsWith('/') ? path : path + '/'

        let meta = await cache.get(path, 'meta')
        if (meta) {
            return meta
        }

        let fullpath = '/'
        let metadata = config.cache.meta[fullpath]
        const fragments = gdrive._trim(path, '/').split('/')

        for (let name of fragments) {
            fullpath += name + '/'

            meta = await cache.get(fullpath, 'meta')
            if (!meta) {
                name = decodeURIComponent(name).replace(/\'/g, "\\'")
                const result = await gdrive.queryDrive({
                    'includeItemsFromAllDrives': true,
                    'supportsAllDrives': true,
                    q: `'${metadata.id}' in parents and name = '${name}' and trashed = false`,
                    fields: `files(id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata, parents)`,
                })
                cache.put(fullpath, result.files[0], 'meta')
            }
            metadata = config.cache.meta[fullpath]
            if (!metadata) break
        }
        return config.cache.meta[path]
    },
    getObjects: async (id) => {
        let pageToken
        const list = []
        const params = {
            pageSize: 1000,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${id}' in parents and trashed = false AND name != '.password'`,
            fields: `nextPageToken, files(id, name, mimeType, size, modifiedTime, description, iconLink, thumbnailLink, imageMediaMetadata)`,
            orderBy: 'folder, name'
        }

        do {
            if (pageToken) params.pageToken = pageToken
            const result = await gdrive.queryDrive(params)
            pageToken = result.nextPageToken
            list.push(...result.files)
        } while (
            pageToken
        )
        return list
    },
    getRawContent: async (id, range, abuse) => {
        const param = abuse ? '&acknowledgeAbuse=true' : ''
        
        // fetch
        // const response = await fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media' + param, {
        //     headers: {
        //         Range: range || '',
        //         Authorization: 'Bearer ' + (await gdrive.getAccessToken())
        //     }
        // })
        // return response

        // XFetch.js fix google api cdn bug
        return await xf.get(`https://www.googleapis.com/drive/v3/files/${id}`, {
            qs: {
                includeItemsFromAllDrives: true,
                supportsAllDrives: true,
                alt: 'media',
                acknowledgeAbuse: abuse ? 'true' : 'false'
            },
            headers: {
                Range: range,
                Authorization: 'Bearer ' + (await gdrive.getAccessToken())
            }
        })
    },
    queryDrive: async (params) => {
        const driveUrl = 'https://www.googleapis.com/drive/v3/files?' + gdrive._encodeQueryString(params)
        const response = await fetch(driveUrl, {
            headers: {
                Authorization: 'Bearer ' + (await gdrive.getAccessToken())
            }
        })
        const result = await response.json()
        if (result.error) {
            if (result.error.message.startsWith('User Rate Limit Exceeded')) {
                return gdrive.queryDrive(params)
            }
            const error = new Error(result.error.message)
            error.status = response.status
            throw error
        }
        return result
    },
    getQuota: async () => {
        const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
            headers: {
                Authorization: 'Bearer ' + (await gdrive.getAccessToken())
            }
        })
        const result = await response.json()
        if (result.storageQuota) {
            return {
                available: result.storageQuota.limit - result.storageQuota.usage,
                used: result.storageQuota.usage
            }
        }
    },
    getAccessToken: async () => {
        let token = await cache.get('token', 'config')
        if (token && token.expires && token.expires > Date.now()) {
            return token.access_token
        }
        var post_data;
        if (config.service_account && typeof config.service_account_json != "undefined") {
            const jwttoken = await JSONWebToken.generateGCPToken(config.service_account_json);
            post_data = {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwttoken,
            };
        } else {
            post_data = {
                client_id: config.client_id,
                client_secret: config.client_secret,
                refresh_token: config.refresh_token,
                grant_type: "refresh_token",
            };
        }
        const response = await fetch('https://www.googleapis.com/oauth2/v4/token', {
            method: 'POST',
            body: gdrive._encodeQueryString(post_data),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })
        const result = await response.json()
        if (result.error) {
            const error = new Error(result.error_description)
            error.status = response.status
            throw error
        }
        cache.put('token', {
            expires: Date.now() + 3500 * 1000,
            access_token: result.access_token
        }, 'config')
        return result.access_token
    },
    pathJoin: (...arguments) => {
        let result = arguments.join('/').replace(/\\/g, '/').replace(/(?<!^)\/+/g, '/').replace(/\/\//g, '/')
        return result
    },
    getUrl: (url) => {
        let rpath = decodeURIComponent(new URL(url).pathname);
        let fpath = gdrive.pathJoin(config.working_dir, rpath);

        return {
            rpath,
            fpath
        }
    },
    _encodeQueryString: (data) => {
        const result = []
        for (let k in data) {
            result.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
        }
        return result.join('&')
    },
    _trim: (string, char) => {
        return char ?
            string.replace(new RegExp('^\\' + char + '+|\\' + char + '+$', 'g'), '') :
            string.replace(/^\s+|\s+$/g, '')
    }

}

const arrayToXml = function(rpath, files, cursor) {
    var entries = files.map(function(file) {
        if (!file.lastmodified) file.lastmodified = new Date().toGMTString()
        return [
            '<d:response>',
                `<d:href>${encodeURI(gdrive.pathJoin(rpath, file.name))}</d:href>`,
                '<d:propstat>',
                    '<d:prop>',
                        `<d:getlastmodified>${file.lastmodified}</d:getlastmodified>`,
                        file.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype />',
                        !file.dir ? `<d:getcontentlength>${file.size}</d:getcontentlength>` : '<d:getcontentlength />',
                        file.quota ? `<d:quota-used-bytes>${file.quota.used}</d:quota-used-bytes><d:quota-available-bytes>${file.quota.available}</d:quota-available-bytes>` : '',
                    '</d:prop>',
                    '<d:status>HTTP/1.1 200 OK</d:status>',
                '</d:propstat>',
            '</d:response>',
        ].filter(function(e) { return e; }).join('\n');
    }).join('\n');

    var new_cursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : '';
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:R="https://www.contoso.com/schema/">${entries}${new_cursor}</d:multistatus>`;

};

// basic
// const arrayToHtml = function(rpath, files, cursor) {
//     var entries = files.map(function(file) {
//         if (file.dir) file.name = file.name + '/'
//         if (!file.lastmodified) file.lastmodified = '-'
//         return [
//             `<a href="${gdrive.pathJoin(rpath, file.name)}">${file.name}</a>                                            ${file.lastmodified}       ${file.size}`,
//         ].filter(function(e) { return e; }).join('\n');
//     }).join('\n');
//     return `<html><head><title>Index of ${rpath}</title></head><body bgcolor="white"><h1>Index of ${rpath}</h1><hr><pre>${entries}</pre><hr></body></html>`;
// }

const arrayToHtml = function(rpath, files, cursor) {
    const tpl = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAApVBMVEUAAAD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+4/eNVAAAANnRSTlMA9isRpA3y8NfOoQjl3amJgVcX2sm/cUAw+MO6s5ttOhsU+urfrZB6dWZQRCPSlUsyBeueYCQaPAIhAAABdUlEQVQ4y23S2WKCQAwF0EsRkMWyivvWqrVqF7vc//+0mjhQRM9TkoEZJgENi/l34bp+UB5wx6n0WesmDlrSiFe+XnEl0OoTG6bNTcZUh4eLF81yG5VCC7vZtCp0tdALTdrR1AK4N5UhVR9qT5UCCXH1DktNXI0LCbnFRTiiks+YUx2lfuAKqqrG57Cn0QzKL2CsteyFWGgwcszWHOBiQLVHSVH3bdSrook5Y6Y3bnT0w4SZuamOaGGKD+f4GUYsKxGk/3UH9emkyjxpnz5Q3S2lyhrfaUnbX2Dwws9WK9t2HPTliOD/0He6lmCe592zN58cY0drUU1o4NgiO098OPz8/J2SWzkogvI2uBZ6OsKI3En6SrSMScsB5PeRRnPeWv+QEZnJboDARcszyaUEPxpw2FpPtGfVWMb9bWt9SfLNxCf5JTadThB0xKNak14Gw855h3dEzZnwRrFEU2m11hO0ZHHU2P39iFthGk96rrvux6mN2h80rVPh8HjxPAAAAABJRU5ErkJggg=="/>
  <title>My Cloud Drive{{title}}</title>
  <!-- Include Bootswatch CSS file -->
  <link rel="stylesheet" href="https://bootswatch.com/5/`+config.theme+`/bootstrap.min.css">
  <style>
  * {
    box-sizing: border-box;
  }

  body {
    font: 15px/1.3 Helvetica, Arial;
    background: var(--bs-body-bg);
    color: var(--bs-gray-200);
  }

  h1,
  main {
    background: var(--bs-dark);
    max-width: 960px;
    margin: 10px auto;
    border-radius: 5px;
  }

  h1 {
    font-size: 18px;
    padding: 15px;
    border: var(--bs-border);
    color: var(--bs-light);
    background: var(--bs-gray-800);
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  h1 a,
  main a {
    display: flex;
    align-items: center;
  }

  main a:first-child {
    border-top-left-radius: 5px;
    border-top-right-radius: 5px;
  }

  main a:last-child {
    border-bottom-left-radius: 5px;
    border-bottom-right-radius: 5px;
  }

  svg {
    margin-right: 15px;
    fill: var(--bs-info);
  }

  h1:hover {
    color: var(--bs-light);
  }

  main {
    border: var(--bs-border);
  }

  main img {
    margin-right: 10px;
  }

  main a {
    padding: 12px 15px;
    border-bottom: var(--bs-border);
    transition: all .3s;
  }

  main a:last-child {
    border: none;
  }

  main a:hover {
    background: var(--bs-gray-800);
    color: var(--bs-primary);
  }

  main a>div {
    margin-left: 10px;
  }

  main a>div:first-child {
    flex: 1;
    margin: 0;
    white-space: pre-line;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
  }

  main a>div:not(:first-child) {
    color: var(--bs-secondary);
    font-size: 13px;
    margin-top: 5px;
  }

  footer {
    text-align: center;
    color: var(--bs-secondary);
    font-size: 13px;
  }

  footer a:hover {
    text-decoration: underline;
  }

  @media (max-width: 640px) {
    main a>div:last-child {
      display: none;
    }
  }
</style>
</head>
<body>
  <h1><a href="/"><svg width="32" height="32" viewBox="0 0 320 320"><path d="M95 304 c-47 -24 -71 -51 -84 -95 -26 -87 20 -173 107 -199 145 -44 262 135 165 251 -48 56 -128 75 -188 43z m168 -73 c9 -16 17 -32 17 -35 0 -3 -35 -6 -78 -6 -85 0 -78 -4 -110 63 -2 4 32 7 75 7 76 0 79 -1 96 -29z m-149 -46 c38 -65 38 -65 16 -100 -22 -36 -22 -36 -62 32 -40 68 -40 68 -22 101 9 17 20 32 23 32 4 0 24 -29 45 -65z m166 -9 c0 -12 -75 -129 -86 -133 -7 -2 -26 -3 -42 -1 -30 3 -30 3 9 71 39 65 41 67 79 67 22 0 40 -2 40 -4z" /></svg>My Cloud Drive</a></h1>
  <main>{{content}}</main>
  <footer><a target="_blank" href="`+config.link+`">`+config.name+`</a></footer>
</body>
</html>`

    let frag = []
    const title = rpath == '/' ? '' : ' - ' + rpath
    rpath == '/' || frag.push(`<a href="../"><div><img src="/_/16/type/application/vnd.google-apps.folder"><b>../</b></div></a>`)
    files && files.forEach(entry => {
        entry.iconLink = entry.iconLink.replace('https://drive-thirdparty.googleusercontent.com/','/_/')
        if (entry.dir) {
            frag.push(`<a href="${encodeURIComponent(entry.name)}/">`)
            frag.push(`<div><img src="${entry.iconLink}"/><b>${entry.name}</b></div>`)
            entry.lastmodified && frag.push(`<div>${new Date(entry.lastmodified).toISOString().split('T')[0]}</div>`)
            frag.push('</a>')
        } else {
            frag.push(`<a href="${encodeURIComponent(entry.name)}" target="_blank">`)
            frag.push(`<div><img src="${entry.iconLink}"/>${entry.name}</div>`)
            frag.push(`<div>${formatSize(entry.size)}</div>`)
            entry.lastmodified && frag.push(`<div>${new Date(entry.lastmodified).toISOString().split('T')[0]}</div>`)
            frag.push('</a>')
        }
    })

    return tpl.trim().replace(/{{content}}/, frag.join('')).replace(/{{title}}/, title)
}

const formatSize = (n) => {
    n = Math.round(n)
    if (n == 0) return ''
    if (n < 1024) return n + 'B'
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'K'
    return parseFloat((n / 1024 / 1024).toFixed(1)) + 'M'
}

// XFetch.js modified
const xf=(()=>{const METHODS=['get','post','put','patch','delete','head'];class HTTPError extends Error{constructor(res){super(res.statusText);this.name='HTTPError';this.response=res}}class XResponsePromise extends Promise{}const{assign}=Object;function mergeDeep(target,source){const isObject=obj=>obj&&typeof obj==='object';if(!isObject(target)||!isObject(source)){return source}Object.keys(source).forEach(key=>{const targetValue=target[key];const sourceValue=source[key];if(Array.isArray(targetValue)&&Array.isArray(sourceValue)){target[key]=targetValue.concat(sourceValue)}else if(isObject(targetValue)&&isObject(sourceValue)){target[key]=mergeDeep(Object.assign({},targetValue),sourceValue)}else{target[key]=sourceValue}});return target}const fromEntries=ent=>ent.reduce((acc,[k,v])=>(acc[k]=v,acc),{});const typeis=(...types)=>val=>types.some(type=>typeof type==='string'?typeof val===type:val instanceof type);const isstr=typeis('string');const isobj=typeis('object');const isstrorobj=v=>isstr(v)||isobj(v);const responseErrorThrower=res=>{if(!res.ok)throw new HTTPError(res);return res};const extend=(defaultInit={})=>{const xfetch=(input,init={})=>{mergeDeep(init,defaultInit);const createQueryString=o=>new init.URLSearchParams(o).toString();const parseQueryString=s=>fromEntries([...new init.URLSearchParams(s).entries()]);const url=new init.URL(input,init.baseURI||undefined);if(!init.headers){init.headers={}}else if(typeis(init.Headers)(init.headers)){init.headers=fromEntries([...init.headers.entries()])}if(init.json){init.body=JSON.stringify(init.json);init.headers['Content-Type']='application/json'}else if(isstrorobj(init.urlencoded)){init.body=isstr(init.urlencoded)?init.urlencoded:createQueryString(init.urlencoded);init.headers['Content-Type']='application/x-www-form-urlencoded'}else if(typeis(init.FormData,'object')(init.formData)){if(!typeis(init.FormData)(init.formData)){const fd=new init.FormData();for(const[k,v]of Object.entries(init.formData)){fd.append(k,v)}init.formData=fd}init.body=init.formData}if(init.qs){if(isstr(init.qs))init.qs=parseQueryString(init.qs);url.search=createQueryString(assign(fromEntries([...url.searchParams.entries()]),init.qs))}return XResponsePromise.resolve(init.fetch(url,init).then(responseErrorThrower))};for(const method of METHODS){xfetch[method]=(input,init={})=>{init.method=method.toUpperCase();return xfetch(input,init)}}xfetch.extend=newDefaultInit=>extend(assign({},defaultInit,newDefaultInit));xfetch.HTTPError=HTTPError;return xfetch};const isWindow=typeof document!=='undefined';const isBrowser=typeof self!=='undefined';return isBrowser?extend({fetch:fetch.bind(self),URL,Response,URLSearchParams,Headers,FormData,baseURI:isWindow?document.baseURI:''}):extend()})();

const basicAuthentication = (request) => {
    const Authorization = request.headers.get('Authorization')
    const [scheme, encoded] = Authorization.split(' ')
  
    if (!encoded || scheme !== 'Basic') {
        return new Response('Bad Request', { status: 400 })
    }
  
    const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const decoded = new TextDecoder().decode(buffer).normalize()
    const index = decoded.indexOf(':')
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
        return new Response('Bad Request', { status: 400 })
    }
  
    return {
      user: decoded.substring(0, index),
      pass: decoded.substring(index + 1),
    }
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
    try {
        const { protocol, pathname } = new URL(request.url)
        const method = request.method.toUpperCase()

        if (pathname == '/robots.txt') {
            return new Response('User-agent: *\nDisallow: /', { status: 200 })
        }
        
        if (pathname == '/favicon.ico') {
            return new Response(null, { status: 204 })
        }
        
        if (pathname.indexOf('/desktop.ini') != -1) {
            return new Response(null, { status: 404 })
        }

        if (pathname.startsWith('/_/')) {
            let url = new URL(request.url)
            url.hostname = 'drive-thirdparty.googleusercontent.com'
            url.pathname = url.pathname.slice(2)
            let response = await fetch(new Request(url, request))
            response = new Response(response.body, response)
            response.headers.set('Access-Control-Allow-Origin', '*')
            response.headers.set('Cache-Control', 'public, max-age=16768000')
            return response
        }

        if (pathname == '/logout') {
            return new Response('Logged out.', { status: 401 })
        }

        if (pathname.startsWith('/dav/')) {

            if ('https:' !== protocol || 'https' !== request.headers.get('x-forwarded-proto')) {
                return new Response('Please use a HTTPS connection.', { status: 400 })
            }
    
            if (request.headers.has('Authorization')) {
                const { user, pass } = basicAuthentication(request)
                
                if (!config.users[user] || config.users[user] !== pass) {
                    return new Response('Unauthorized', { status: 401 })
                }
    
                //if (method == 'patch') method = 'proppatch'
                if (method == 'patch') method = 'copy'
                if (gdrive.methods[method]) {
                    return await gdrive.methods[method](request)
                }
    
                return new Response(null, { status: 403 })
            }
    
            return new Response('You need to login.', {
                status: 401,
                headers: {
                    'WWW-Authenticate': 'Basic realm="DAV", charset="UTF-8"',
                },
            })

        }

        if (pathname == '/dav') {
            return Response.redirect( request.url + '/', 301)
        }

        // PROPFIND
        if (pathname == '/' && method == 'PROPFIND') {
            const content = arrayToXml('/', [{
                name: '',
                dir: true,
                lastmodified: null
            },
            {
                name: 'dav/',
                dir: true,
                lastmodified: null
            }])
            return new Response(content, { status: 207 })
        }

        // index
        if (method == 'GET'){
            if (request.headers.has('Authorization')) {
                const { user, pass } = basicAuthentication(request)
                
                if (!config.users[user] || config.users[user] !== pass) {
                    return new Response('Unauthorized', { status: 401 })
                }
    
                //if (method == 'patch') method = 'proppatch'
                if (gdrive.methods[method]) {
                    return await gdrive.methods[method](request)
                }
    
                return new Response(null, { status: 403 })
            }
            return new Response('You need to login.', {
                status: 401,
                headers: {
                    'WWW-Authenticate': 'Basic realm="DAV", charset="UTF-8"',
                },
            })
        }

        return new Response(null, { status: 403 })

    } catch (e) {
        const status = e.code || 500
        return new Response(status + ': ' + e.message, {
            status
        })
    }
}
