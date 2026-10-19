"""Launch only Navigator's synthetic SQLite fixture, never production configuration."""
import json
import sys
import struct
import zlib
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from test_navigator_fixture import NavigatorFixture
import manual_server

with NavigatorFixture() as fixture:
    manual_server.HERE = Path(fixture.directory.name)
    image_dir = manual_server.HERE / 'images'
    image_dir.mkdir()
    def chunk(kind, value):
        return struct.pack('>I',len(value)) + kind + value + struct.pack('>I',zlib.crc32(kind+value))
    image_bytes = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(b'\x00\xff\x00\x00\xff')) + chunk(b'IEND',b'')
    (image_dir / 'fixture-image-id-123_1_1.png').write_bytes(image_bytes)
    connection = fixture.connect()
    for index in range(3):
        connection.execute("INSERT INTO freight_items(record_type,entry_id,content_key,pod,route,pol,price_usd,container_type,carrier,valid_to,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ('rates',str(index),'integration-'+str(index),'SANTOS','Brazil','Shekou',100+index,'40HC','ZIM','2099-12-31','current'))
    connection.commit()
    connection.execute("UPDATE freight_items SET image_file='@fixture-image-id-123'")
    # Exercise shared quote-image access with a non-admin account.
    connection.execute("UPDATE operators SET role='sales' WHERE name='fixture-admin'")
    connection.commit()
    connection.close()
    # This password belongs to the disposable fixture; it is not a real credential.
    print(json.dumps({'base':fixture.base_url,'password':fixture.password}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command['action'] == 'exit': break
        connection = fixture.connect()
        if command['action'] == 'stats':
            result = [dict(row) for row in connection.execute('SELECT user_id,properties_json FROM user_activity_events')]
        elif command['action'] == 'expire':
            connection.execute("UPDATE prospector_tokens SET expires_at=0 WHERE kind='access'")
            connection.commit()
            result = True
        elif command['action'] == 'disable':
            connection.execute('UPDATE operators SET active=0')
            connection.commit()
            result = True
        else: raise ValueError('Unknown fixture command')
        connection.close()
        print(json.dumps(result), flush=True)
