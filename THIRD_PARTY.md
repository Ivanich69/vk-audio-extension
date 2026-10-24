# Third-party notices

The URL transformations in `audio-decoder.js` are adapted from
[`python273/vk_api`, `vk_api/audio_url_decoder.py`](https://github.com/python273/vk_api/blob/master/vk_api/audio_url_decoder.py).
The upstream project is distributed under the Apache License, Version 2.0;
its audio module credits python273, copyright (c) 2019.
The license is included in `licenses/vk_api-Apache-2.0.txt`.

Modifications: a JavaScript implementation of the URL transformations,
bounded decoding, explicit failure reasons, HTTPS validation, integration
with passive Fetch/XHR and DevTools capture. No upstream API requests,
cookie handling, or HLS-to-MP3 URL substitution is included.
